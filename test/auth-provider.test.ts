import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { ExternalAuth, loadExternalAuth, type AuthProvider } from "../src/server/auth-provider.ts";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

const policy = {
    owner: "owner@example.com",
    guests: ["guest@example.com"],
    origin: "https://pocket.example.com",
};
const provider: AuthProvider = {
    id: "test-identity",
    async authenticate(request) {
        const subject = request.headers["test-subject"];

        return typeof subject === "string" ? { subject, name: "Same display name" } : undefined;
    },
};
const data = join(root, "external-auth");
const guestCapability = "example.com/cap/pi-pocket";
/** Like Tailscale Serve's `--accept-app-caps`: verified capabilities next to the verified subject. */
const capabilityProvider: AuthProvider = {
    id: "test-capability-identity",
    async authenticate(request) {
        const subject = request.headers["test-subject"];
        const capabilities = request.headers["test-capabilities"];

        return typeof subject === "string"
            ? {
                  subject,
                  ...(typeof capabilities === "string"
                      ? { capabilities: JSON.parse(capabilities) }
                      : {}),
              }
            : undefined;
    },
};
let app: App | undefined;
let server: Server | undefined;

async function serve(external = new ExternalAuth(provider, policy)): Promise<string> {
    server = createServer(
        createHandler({
            app: app!,
            externalAuth: external,
            listen: { host: "127.0.0.1", port: 0 },
            restart() {},
        }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function stopServer(): Promise<void> {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
        server === undefined ? resolve() : server.close(() => resolve()),
    );
    server = undefined;
}

afterEach(stopServer);

after(async () => {
    await stopServer();
    await app?.close();
    cleanUp();
});

const headers = (subject = policy.owner) => ({ "test-subject": subject });
const post = (subject = policy.owner, body = {}) => ({
    method: "POST",
    headers: {
        ...headers(subject),
        origin: policy.origin,
        "x-pocket": "1",
        "content-type": "application/json",
    },
    body: JSON.stringify(body),
});

test("external auth gates every dispatch branch, never falls back to native tokens, and disables pairing", async () => {
    app = await openApp(scriptedModel(), data);
    const base = await serve();
    const token = app.config.ownerToken;
    const native = app.config.addUser("Native guest", "guest");
    const paths = [
        "/",
        "/s/1",
        "/index.html",
        "/app.js",
        "/sw.js",
        "/vendor/preact",
        "/api/me",
        "/api/events",
        "/api/poll",
        "/a/1/file.html",
        "/pub/token",
        "/pub/token/file.js",
        "/l/token",
        "/hook/token",
        "/x/module/index.js",
        "/themes/pocket/theme.css",
        `/login?token=${token}`,
        "/join/invite",
        "/share",
    ];

    for (const path of paths) {
        for (const credentials of [
            {} as Record<string, string>,
            { authorization: `Bearer ${token}` },
            { cookie: `pocket_auth=${native.token}` },
        ]) {
            const response = await fetch(base + path, { headers: credentials });

            assert.equal(response.status, 403, path);
            assert.doesNotMatch(await response.text(), new RegExp(token));
        }
    }

    assert.equal(
        (await fetch(base + "/api/me", { headers: headers("not-allowed@example.com") })).status,
        403,
    );
    const me = await (await fetch(base + "/api/me", { headers: headers() })).json();

    assert.equal(me.user.id, owner(app).id);
    assert.equal(me.user.role, "owner");
    assert.equal(me.server.authenticationMode, "external");
    assert.equal((await fetch(base + "/", { headers: headers() })).status, 200);

    for (const path of ["/login?token=" + token, "/join/invite"]) {
        const response = await fetch(base + path, { headers: headers() });

        assert.equal(response.status, 403);
        assert.equal(response.headers.get("set-cookie"), null);
    }

    for (const path of ["/api/invite", "/api/invite/cancel", "/api/logout"]) {
        assert.equal((await fetch(base + path, post())).status, 403);
    }

    const auth = new Auth(app.config, new ExternalAuth(provider, policy));

    assert.equal(auth.tokenUser(token), undefined);
    assert.equal(auth.redeem("unused", "Guest"), undefined);
    assert.throws(() => auth.createInvite(owner(app!)), /Pairing is disabled/);
    await stopServer();
});

test("full identity binds one native person across browsers/restarts; role, scope, budget and removal survive", async () => {
    const base = await serve();
    const first = await (
        await fetch(base + "/api/me", { headers: headers(policy.guests[0]) })
    ).json();
    const guest = app!.config.userById(first.user.id)!;
    const firstSession = await newSession(app!);
    const otherSession = await newSession(app!);

    assert.equal(guest.role, "guest");
    assert.notEqual(guest.id, owner(app!).id, "same display name is not identity");
    assert.equal(guest.tokenHash, "", "no gateway bearer credential pile");
    const second = await (
        await fetch(base + "/api/me", {
            headers: { ...headers(policy.guests[0]), cookie: "pocket_auth=another-browser" },
        })
    ).json();

    assert.equal(second.user.id, guest.id);
    const created = await fetch(base + "/api/sessions", post(policy.guests[0], { cwd: root }));

    assert.equal(created.status, 200, "explicitly admitted guest retains native session creation");
    const sessions = await (
        await fetch(base + "/api/sessions", { headers: headers(policy.guests[0]) })
    ).json();

    assert.ok(
        sessions.some((session: { id: number }) => session.id === Number(firstSession)),
        "native initial all-session access",
    );
    const poll = await (
        await fetch(base + "/api/poll?tab=external-poll", { headers: headers(policy.guests[0]) })
    ).json();

    assert.ok(
        poll.events.some(
            (event: { event: string; data: { user?: { id: string } } }) =>
                event.event === "hello" && event.data.user?.id === guest.id,
        ),
    );
    assert.equal(
        (await fetch(base + `/api/poll?session=${poll.session}`)).status,
        403,
        "poll session is not authentication",
    );
    await fetch(base + `/api/poll?session=${poll.session}&close=1`, {
        headers: headers(policy.guests[0]),
    });
    const events = await fetch(base + "/api/events?tab=external-stream", {
        headers: headers(policy.guests[0]),
    });

    assert.equal(events.status, 200);
    await events.body!.cancel();
    app!.setAccess(owner(app!), guest.id, { role: "viewer", sessions: [Number(firstSession)] });
    app!.config.updateUser(guest.id, { budget: 2 });
    const downgraded = await (
        await fetch(base + "/api/me", { headers: headers(policy.guests[0]) })
    ).json();

    assert.equal(downgraded.user.role, "viewer");
    assert.deepEqual(downgraded.user.sessions, [Number(firstSession)]);
    assert.equal(
        (
            await fetch(base + `/api/c/${Number(otherSession)}`, {
                headers: headers(policy.guests[0]),
            })
        ).status,
        404,
    );
    assert.equal(
        (await fetch(base + "/api/users/somebody/remove", post(policy.guests[0]))).status,
        403,
    );
    assert.equal((await fetch(base + "/api/sessions", post(policy.guests[0]))).status, 403);
    await stopServer();
    await app!.close();
    app = await openApp(scriptedModel(), data);
    const restarted = await serve();
    const retained = await (
        await fetch(restarted + "/api/me", { headers: headers(policy.guests[0]) })
    ).json();

    assert.equal(retained.user.id, guest.id);
    assert.equal(retained.user.role, "viewer");
    assert.deepEqual(retained.user.sessions, [Number(firstSession)]);
    assert.equal(app.config.userById(guest.id)?.budget, 2);
    app.removeUser(owner(app), guest.id);
    assert.equal(
        (await fetch(restarted + "/api/me", { headers: headers(policy.guests[0]) })).status,
        403,
    );
    const disk = new ConfigStore(data);

    assert.equal(
        disk.externalUser(provider.id, policy.guests[0]!, false),
        undefined,
        "tombstone survives restart",
    );
    assert.equal(
        disk.externalUser(provider.id, policy.guests[0]!, true),
        undefined,
        "owner mapping cannot elevate bound guest",
    );
    assert.equal(
        disk.externalUser(provider.id, "new-owner@example.com", true),
        undefined,
        "no automatic replacement owner",
    );
    await stopServer();
});

test("external CSRF uses pinned origin, not forwarded Host or X-Pocket alone", async () => {
    const base = await serve();

    for (const origin of ["https://hostile.example", "null", undefined]) {
        const response = await fetch(base + "/api/me", {
            method: "POST",
            headers: {
                ...headers(),
                "x-pocket": "1",
                ...(origin === undefined ? {} : { origin }),
                "x-forwarded-host": "hostile.example",
                "x-forwarded-proto": "https",
            },
            body: JSON.stringify({ name: "Forged" }),
        });

        assert.equal(response.status, 403);
    }

    assert.equal(
        (await fetch(base + "/api/me", post(policy.owner, { name: "Owner" }))).status,
        200,
    );
    assert.equal(
        (
            await fetch(base + "/api/me", {
                method: "POST",
                headers: { ...headers(), origin: policy.origin },
                body: "{}",
            })
        ).status,
        403,
        "native X-Pocket check retained",
    );
    assert.equal(
        (
            await fetch(base + "/api/me", {
                headers: { ...headers(), origin: "https://hostile.example" },
            })
        ).status,
        403,
    );
    await stopServer();
});

/** Exact request headers: fetch() would replace the Fetch Metadata that a browser sends. */
function exactRequest(
    base: string,
    path: string,
    options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<number> {
    return new Promise((resolve, reject) => {
        const sent = request(base + path, options, (response) => {
            response.resume();
            resolve(response.statusCode!);
        });

        sent.on("error", reject);
        sent.end(options.body);
    });
}

test("a link from another site opens the app; cross-site frames, subresources and posts stay denied", async () => {
    const base = await serve();
    const crossSite = (fetchHeaders: Record<string, string>, subject = policy.owner) => ({
        ...headers(subject),
        "sec-fetch-site": "cross-site",
        ...fetchHeaders,
    });
    const link = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

    // A Slack, GitHub or mail link to a session: the browser sends no Origin on this GET.
    for (const method of ["GET", "HEAD"]) {
        for (const path of ["/s/1", "/"]) {
            assert.equal(
                await exactRequest(base, path, { method, headers: crossSite(link) }),
                200,
                `${method} ${path}`,
            );
        }
    }

    assert.equal(
        await exactRequest(base, "/s/1", {
            headers: crossSite({ ...link, origin: policy.origin }),
        }),
        200,
    );
    // Still the identity first, and never another origin.
    assert.equal(
        await exactRequest(base, "/s/1", {
            headers: crossSite(link, "not-allowed@example.com"),
        }),
        403,
    );
    assert.equal(
        await exactRequest(base, "/s/1", {
            headers: crossSite({ ...link, origin: "https://hostile.example" }),
        }),
        403,
    );

    const denied: Record<string, string>[] = [
        { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
        { "sec-fetch-mode": "navigate", "sec-fetch-dest": "embed" },
        { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
        { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
        { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
        { "sec-fetch-mode": "navigate" },
        { "sec-fetch-dest": "document" },
        {},
    ];

    for (const fetchHeaders of denied) {
        for (const path of ["/s/1", "/app.js", "/api/me"]) {
            assert.equal(
                await exactRequest(base, path, { headers: crossSite(fetchHeaders) }),
                403,
                `${path} ${JSON.stringify(fetchHeaders)}`,
            );
        }
    }

    // A cross-site form post is a document navigation too: methods other than GET and HEAD stay denied.
    for (const origin of [policy.origin, undefined]) {
        const status = await exactRequest(base, "/api/me", {
            method: "POST",
            headers: {
                ...crossSite(link),
                ...(origin === undefined ? {} : { origin }),
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Forged" }),
        });

        assert.equal(status, 403);
    }

    assert.notEqual(app!.config.userById(owner(app!).id)?.name, "Forged");
    await stopServer();
});

test("provider errors and timeouts fail closed without leaking error words", async () => {
    for (const authenticate of [
        async () => {
            throw new Error("secret-provider-credential");
        },
        () => new Promise<undefined>(() => {}),
    ]) {
        const base = await serve(new ExternalAuth({ id: "failed", authenticate }, policy, 20));
        const response = await fetch(base + "/api/me", {
            headers: { ...headers(), authorization: `Bearer ${app!.config.ownerToken}` },
        });

        assert.equal(response.status, 503);
        assert.equal(await response.text(), '{"error":"External authentication unavailable"}');
        await stopServer();
    }
});

test("required provider startup refuses missing, invalid, throwing, insecure and hanging modules", async () => {
    assert.equal(await loadExternalAuth(undefined), undefined);
    await assert.rejects(loadExternalAuth(join(root, "absent.json")), /Could not initialize/);
    const config = join(root, "auth.json");
    const module = join(root, "provider.mjs");

    for (const code of [
        "export default () => undefined",
        'throw new Error("secret-startup-credential")',
        "export default () => new Promise(() => {})",
    ]) {
        writeFileSync(module, code, { mode: 0o600 });

        // Use a distinct module filename to avoid import caching (module paths are filesystem paths, not URLs).
        const unique = module + String(Math.random()) + ".mjs";

        writeFileSync(unique, code, { mode: 0o600 });
        writeFileSync(config, JSON.stringify({ ...policy, module: unique }), { mode: 0o600 });
        await assert.rejects(loadExternalAuth(config), {
            message: "Could not initialize required external authentication provider",
        });
    }

    writeFileSync(
        module,
        'export default () => ({ id: "startup", async authenticate() { return undefined; } })',
    );
    writeFileSync(config, JSON.stringify({ ...policy, module }));
    assert.ok(await loadExternalAuth(config));
    chmodSync(config, 0o644);
    await assert.rejects(loadExternalAuth(config), /Could not initialize/);
    assert.doesNotMatch(
        readFileSync(join(data, "config.json"), "utf8"),
        /secret-provider-credential/,
    );
});

test("guestCapability must be a domain/path capability name; the explicit guest list may be omitted", async () => {
    const capabilityPolicy = { owner: policy.owner, origin: policy.origin, guestCapability };

    assert.ok(new ExternalAuth(capabilityProvider, capabilityPolicy));
    assert.ok(new ExternalAuth(capabilityProvider, { ...capabilityPolicy, guests: [] }));
    assert.ok(new ExternalAuth(provider, { owner: policy.owner, origin: policy.origin }));

    for (const invalid of [
        "",
        "pi-pocket",
        "example.com",
        "example.com/",
        "/cap/pi-pocket",
        "example/cap/pi-pocket",
        "Example.com/cap/pi-pocket",
        "example.com/cap pi-pocket",
        "example.com/cap/pi-pocket\n",
        "https://example.com/cap/pi-pocket",
        42,
        null,
        [guestCapability],
    ]) {
        assert.throws(
            () =>
                new ExternalAuth(capabilityProvider, {
                    ...capabilityPolicy,
                    guestCapability: invalid as string,
                }),
            /Invalid external authentication configuration/,
            JSON.stringify(invalid),
        );
    }

    assert.throws(
        () => new ExternalAuth(provider, { ...policy, guests: "guest@example.com" as never }),
        /Invalid external authentication configuration/,
    );
    const config = join(root, "capability-auth.json");
    const module = join(root, "capability-provider.mjs");

    writeFileSync(
        module,
        'export default () => ({ id: "startup", async authenticate() { return undefined; } })',
        { mode: 0o600 },
    );
    writeFileSync(config, JSON.stringify({ ...capabilityPolicy, module }), { mode: 0o600 });
    assert.ok(await loadExternalAuth(config));
    writeFileSync(config, JSON.stringify({ ...capabilityPolicy, guestCapability: "pi", module }));
    await assert.rejects(loadExternalAuth(config), /Could not initialize/);
});

test("an app capability admits one persistent native guest per request; losing it denies without removing the person", async () => {
    const capabilityData = join(root, "external-capability-auth");
    const capabilityPolicy = { owner: policy.owner, origin: policy.origin, guestCapability };
    const granted = { [guestCapability]: [{ role: "guest" }] };
    const as = (subject: string, capabilities?: unknown) => ({
        headers: {
            ...headers(subject),
            ...(capabilities === undefined
                ? {}
                : { "test-capabilities": JSON.stringify(capabilities) }),
        },
    });
    const member = "member@example.com";

    await app!.close();
    app = await openApp(scriptedModel(), capabilityData);
    let base = await serve(new ExternalAuth(capabilityProvider, capabilityPolicy));

    // The owner is the exact login, with or without the capability.
    for (const capabilities of [undefined, {}, granted]) {
        const me = await (await fetch(base + "/api/me", as(policy.owner, capabilities))).json();

        assert.equal(me.user.id, owner(app).id);
        assert.equal(me.user.role, "owner");
    }

    const users = app.config.users.length;

    // Only a guest role value of the configured capability admits; nothing else creates a person.
    for (const capabilities of [
        undefined,
        {},
        { [guestCapability]: [] },
        { [guestCapability]: [{}] },
        { [guestCapability]: [{ role: "viewer" }] },
        { [guestCapability]: [{ role: "owner" }] },
        { [guestCapability]: ["guest"] },
        { [guestCapability]: [[{ role: "guest" }]] },
        { [guestCapability]: { role: "guest" } },
        { [guestCapability]: null },
        { "example.com/cap/other": [{ role: "guest" }] },
        { "example.com/cap/pi-pocket/extra": [{ role: "guest" }] },
        [granted],
        "granted",
    ]) {
        assert.equal(
            (await fetch(base + "/api/me", as(member, capabilities))).status,
            403,
            JSON.stringify(capabilities),
        );
    }

    assert.equal(app.config.users.length, users);
    const first = await (await fetch(base + "/api/me", as(member, granted))).json();
    const merged = await (
        await fetch(
            base + "/api/me",
            as(member, { [guestCapability]: [{ role: "viewer" }, { role: "guest" }] }),
        )
    ).json();

    assert.equal(first.user.role, "guest");
    assert.notEqual(first.user.id, owner(app).id);
    assert.equal(merged.user.id, first.user.id);
    // Group removal: the next request is denied, but the native person and binding stay.
    assert.equal((await fetch(base + "/api/me", as(member))).status, 403);
    assert.equal((await fetch(base + "/api/me", as(member, {}))).status, 403);
    assert.equal(app.config.userById(first.user.id)?.role, "guest");
    app.setAccess(owner(app), first.user.id, { role: "viewer", sessions: [] });
    const regained = await (await fetch(base + "/api/me", as(member, granted))).json();

    assert.equal(regained.user.id, first.user.id);
    assert.equal(regained.user.role, "viewer", "the capability is no role: People decides");
    await stopServer();
    await app.close();
    app = await openApp(scriptedModel(), capabilityData);
    base = await serve(new ExternalAuth(capabilityProvider, capabilityPolicy));
    const restarted = await (await fetch(base + "/api/me", as(member, granted))).json();

    assert.equal(restarted.user.id, first.user.id);
    assert.equal(restarted.user.role, "viewer");
    assert.equal((await fetch(base + "/api/me", as(member))).status, 403);
    // Removal is a tombstone: the capability cannot recreate the person.
    app.removeUser(owner(app), first.user.id);
    assert.equal((await fetch(base + "/api/me", as(member, granted))).status, 403);
    assert.equal(app.config.users.length, users);
    await stopServer();
    // The explicit list still admits without the capability, next to it.
    base = await serve(
        new ExternalAuth(capabilityProvider, {
            ...capabilityPolicy,
            guests: ["listed@example.com"],
        }),
    );
    const listed = await (await fetch(base + "/api/me", as("listed@example.com"))).json();

    assert.equal(listed.user.role, "guest");
    assert.equal((await fetch(base + "/api/me", as(member, granted))).status, 403);
    await stopServer();
    // Without guestCapability, a capability admits nobody.
    base = await serve(
        new ExternalAuth(capabilityProvider, { owner: policy.owner, origin: policy.origin }),
    );
    assert.equal((await fetch(base + "/api/me", as("unlisted@example.com", granted))).status, 403);
    assert.equal(
        (await (await fetch(base + "/api/me", as(policy.owner))).json()).user.role,
        "owner",
    );
    await stopServer();
});
