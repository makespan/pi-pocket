import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
