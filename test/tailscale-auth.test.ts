import { cleanUp, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
    origin: "https://pocket.example.com",
};
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
