import { cleanUp, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExternalAuth } from "../src/server/auth-provider.ts";
import tailscale from "../src/server/auth-providers/tailscale.ts";
import { createHandler } from "../src/server/http.ts";

const secretFile = join(root, "gateway-secret");
const secret = randomBytes(32).toString("base64url");
const policy = {
    owner: "owner@example.com",
    guests: ["friend@example.com"],
    guestCapability: "example.com/cap/pi-pocket",
    origin: "https://pocket.example.com",
};
/** Serve's `Tailscale-App-Capabilities` for a member of the granted group, with `--accept-app-caps`. */
const granted = JSON.stringify({ [policy.guestCapability]: [{ role: "guest" }] });
let app: App;
let server: Server;
let base: string;

before(async () => {
    writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
    const configFile = join(root, "external-auth.json");

    writeFileSync(
        configFile,
        JSON.stringify({
            ...policy,
            module: fileURLToPath(
                new URL("../src/server/auth-providers/tailscale.ts", import.meta.url),
            ),
            options: { secretFile },
        }),
        { mode: 0o600 },
    );
    const externalAuth = await loadExternalAuth(configFile);

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, externalAuth, listen: { host: "127.0.0.1", port: 0 }, restart() {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
        server === undefined ? resolve() : server.close(() => resolve()),
    );
    await app?.close();
    cleanUp();
});

const headers = (login: string) => ({
    "x-pocket-gateway-secret": secret,
    "tailscale-user-login": login,
});
const withCapabilities = (login: string, capabilities = granted) => ({
    ...headers(login),
    "tailscale-app-capabilities": capabilities,
});

/** RFC 2047 "Q" encoding as Go's mime.QEncoding writes it, which Serve uses for non-ASCII values. */
function qEncode(value: string, charset = "utf-8", wordBytes = 40): string {
    const words: string[] = [];
    const bytes = Buffer.from(value, "utf8");

    for (let start = 0; start < bytes.length; start += wordBytes) {
        let text = "";

        for (const byte of bytes.subarray(start, start + wordBytes)) {
            const char = String.fromCharCode(byte);

            text +=
                byte === 0x20
                    ? "_"
                    : byte >= 0x21 && byte <= 0x7e && !"=?_".includes(char)
                      ? char
                      : "=" + byte.toString(16).toUpperCase().padStart(2, "0");
        }

        words.push(`=?${charset}?q?${text}?=`);
    }

    return words.join(" ");
}

/** Exact header lines, so a header can be sent twice instead of merged into one value. */
function exactStatus(path: string, lines: [string, string | string[]][]): Promise<number> {
    return new Promise((resolve, reject) => {
        const sent = request(base + path, (response) => {
            response.resume();
            resolve(response.statusCode!);
        });

        for (const [name, value] of lines) {
            sent.setHeader(name, value);
        }

        sent.on("error", reject);
        sent.end();
    });
}

test("Tailscale provider denies forged Serve headers on localhost, tagged nodes, missing and unallowed identities", async () => {
    const assertions: Record<string, string>[] = [
        {},
        { "tailscale-user-login": policy.owner },
        {
            ...headers(policy.owner),
            "x-pocket-gateway-secret": randomBytes(32).toString("base64url"),
        },
        { "x-pocket-gateway-secret": secret },
        { ...headers("tag:server"), "tailscale-user-name": "Owner" },
        headers("owner"),
        headers("unallowed@example.com"),
        headers("OWNER@example.com"),
        headers("owner@example.com, friend@example.com"),
        { ...headers(policy.owner), "x-pocket-gateway-secret": secret + "," + secret },
        { "tailscale-user-name": policy.owner, "x-pocket-gateway-secret": secret },
    ];

    for (const assertion of assertions) {
        const response = await fetch(base + "/api/me", {
            headers: {
                ...assertion,
                authorization: `Bearer ${app.config.ownerToken}`,
                cookie: `pocket_auth=${app.config.ownerToken}`,
            },
        });
        const text = await response.text();

        assert.equal(response.status, 403);
        assert.doesNotMatch(text, new RegExp(secret));
        assert.doesNotMatch(text, new RegExp(app.config.ownerToken));
        assert.equal(response.headers.get("set-cookie"), null);
    }
});

test("authenticated full login maps to owner or one persistent native guest, never request-supplied roles", async () => {
    const me = await (await fetch(base + "/api/me", { headers: headers(policy.owner) })).json();

    assert.equal(me.user.id, owner(app).id);
    assert.equal(me.user.role, "owner");
    const guestHeaders = {
        ...headers(policy.guests[0]!),
        "tailscale-user-name": policy.owner,
        "x-pocket-role": "owner",
    };
    const first = await (await fetch(base + "/api/me", { headers: guestHeaders })).json();
    const second = await (await fetch(base + "/api/me", { headers: guestHeaders })).json();

    assert.equal(first.user.role, "guest");
    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.user.id, me.user.id);
    app.setAccess(owner(app), first.user.id, { role: "viewer", sessions: [] });
    const viewer = await (await fetch(base + "/api/me", { headers: guestHeaders })).json();

    assert.equal(viewer.user.role, "viewer");
    assert.deepEqual(viewer.user.sessions, []);
    app.removeUser(owner(app), first.user.id);
    assert.equal((await fetch(base + "/api/me", { headers: guestHeaders })).status, 403);
});

test("Serve's app capability admits a persistent guest on every request; group removal denies the next one", async () => {
    const member = "member@example.com";

    for (const capabilities of [undefined, "{}", granted]) {
        const me = await (
            await fetch(base + "/api/me", {
                headers:
                    capabilities === undefined
                        ? headers(policy.owner)
                        : withCapabilities(policy.owner, capabilities),
            })
        ).json();

        assert.equal(me.user.role, "owner", "the owner needs only the exact login");
        assert.equal(me.user.id, owner(app).id);
    }

    // For a tailnet member outside the granted group, Serve omits the header or sends `{}`.
    assert.equal((await fetch(base + "/api/me", { headers: headers(member) })).status, 403);
    assert.equal(
        (await fetch(base + "/api/me", { headers: withCapabilities(member, "{}") })).status,
        403,
    );
    const first = await (
        await fetch(base + "/api/me", {
            headers: { ...withCapabilities(member), "tailscale-user-name": policy.owner },
        })
    ).json();
    const second = await (
        await fetch(base + "/api/me", { headers: withCapabilities(member) })
    ).json();

    assert.equal(first.user.role, "guest");
    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.user.id, owner(app).id);
    assert.equal(
        (await fetch(base + "/api/me", { headers: withCapabilities(member, "{}") })).status,
        403,
    );
    assert.equal(app.config.userById(first.user.id)?.role, "guest", "not deleted");
    // A non-ASCII grant value arrives RFC 2047 encoded, in several encoded words.
    const encoded = qEncode(
        JSON.stringify({
            [policy.guestCapability]: [{ role: "guest", team: "Entwicklung · Zoë" }],
        }),
    );

    assert.match(encoded, /^=\?utf-8\?q\?.*\?= =\?utf-8\?q\?/);

    // The same grant exactly as Go's `mime.QEncoding.Encode("utf-8", …)` writes it (go1.27.3).
    const goEncoded =
        '=?utf-8?q?{"example.com/cap/pi-pocket":[{"role":"guest","team":"Entwicklu?= ' +
        '=?utf-8?q?ng_=C2=B7_Zo=C3=AB"}]}?=';

    for (const value of [encoded, encoded.replaceAll("=?utf-8?q?", "=?UTF-8?Q?"), goEncoded]) {
        const regained = await (
            await fetch(base + "/api/me", { headers: withCapabilities(member, value) })
        ).json();

        assert.equal(regained.user.id, first.user.id);
    }

    app.removeUser(owner(app), first.user.id);
    assert.equal(
        (await fetch(base + "/api/me", { headers: withCapabilities(member) })).status,
        403,
    );
});

test("forged, malformed, duplicate and oversize app capability headers grant nothing", async () => {
    const member = "capability-member@example.com";
    const users = app.config.users.length;
    const forged: Record<string, string>[] = [
        { "tailscale-user-login": member, "tailscale-app-capabilities": granted },
        {
            ...withCapabilities(member),
            "x-pocket-gateway-secret": randomBytes(32).toString("base64url"),
        },
        { "x-pocket-gateway-secret": secret, "tailscale-app-capabilities": granted },
        { ...withCapabilities("tag:server"), "tailscale-user-name": member },
        { ...withCapabilities("member") },
    ];

    for (const assertion of forged) {
        assert.equal((await fetch(base + "/api/me", { headers: assertion })).status, 403);
    }

    const oversize = JSON.stringify({
        [policy.guestCapability]: [{ role: "guest", padding: "x".repeat(9000) }],
    });
    const malformed = [
        "",
        "not json",
        "{",
        "null",
        "[]",
        '"granted"',
        JSON.stringify([JSON.parse(granted)]),
        JSON.stringify({ [policy.guestCapability]: { role: "guest" } }),
        // One non-list value makes the whole header invalid.
        JSON.stringify({ ...JSON.parse(granted), "example.com/cap/other": true }),
        granted + ", " + granted,
        oversize,
        qEncode(granted, "iso-8859-1"),
        `=?utf-8?b?${Buffer.from(granted).toString("base64")}?=`,
        qEncode(granted).replace("=?utf-8?q?", "=?utf-8?q?=ZZ"),
        // Not UTF-8 (a lone lead byte) inside an otherwise granting JSON string.
        qEncode(
            JSON.stringify({ [policy.guestCapability]: [{ role: "guest", team: "Zo" }] }),
        ).replace("Zo", "Zo=C3"),
        qEncode(granted).replace("=?utf-8?q?", "=?utf-8?q?a?b"),
        qEncode(granted) + " trailing",
        "{} " + qEncode(granted),
        qEncode(granted).replace(" ", "  "),
        qEncode(granted).replace("?=", ""),
        qEncode("x".repeat(9000)),
        // Serve sends non-ASCII only RFC 2047 encoded: raw UTF-8 bytes are not its assertion.
        Buffer.from(
            JSON.stringify({ [policy.guestCapability]: [{ role: "guest", team: "Zoë" }] }),
        ).toString("latin1"),
    ];

    for (const value of malformed) {
        assert.equal(
            await exactStatus("/api/me", [
                ...Object.entries(headers(member)),
                ["tailscale-app-capabilities", value],
            ]),
            403,
            value.slice(0, 80),
        );
        // Capabilities never decide the owner, so a bad header does not lock them out.
        assert.equal(
            await exactStatus("/api/me", [
                ...Object.entries(headers(policy.owner)),
                ["tailscale-app-capabilities", value],
            ]),
            200,
            value.slice(0, 80),
        );
    }

    // Two header lines, even both granting, are not one Serve assertion.
    for (const values of [
        [granted, granted],
        [granted, "{}"],
    ]) {
        assert.equal(
            await exactStatus("/api/me", [
                ...Object.entries(headers(member)),
                ["tailscale-app-capabilities", values],
            ]),
            403,
        );
    }

    assert.equal(app.config.users.length, users, "no person created");
    assert.equal(
        await exactStatus("/api/me", [
            ...Object.entries(headers(member)),
            ["tailscale-app-capabilities", granted],
        ]),
        200,
    );
});

test("Tailscale provider requires a restricted non-symlink secret file with a sufficiently long secret", () => {
    assert.throws(() => tailscale(undefined), /secretFile/);
    assert.throws(() => tailscale({ secretFile: "relative" }), /secretFile/);
    const file = join(root, "bad-secret");

    writeFileSync(file, secret, { mode: 0o644 });
    assert.throws(() => tailscale({ secretFile: file }), /restricted/);
    chmodSync(file, 0o600);
    writeFileSync(file, "short");
    assert.throws(() => tailscale({ secretFile: file }), /32 random bytes/);
    symlinkSync(secretFile, join(root, "linked-secret"));
    assert.throws(() => tailscale({ secretFile: join(root, "linked-secret") }));
});
