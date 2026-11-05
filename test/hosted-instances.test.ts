// The combined hosting contract: two Unix-user-style apps behind one identity gateway and browser origin.
import { cleanUp, home, root, scriptedModel, until, work, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ExternalAuth, type AuthProvider } from "../src/server/auth-provider.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");
const alice = "alice@example.com";
const bob = "bob@example.com";
const mounts = ["/alice.name", "/bob.name"] as const;
let identity: string | undefined = alice;
let apps: App[] = [];
let gateway: Server;
let base = "";
let browsers: Browsers | undefined;
const provider: AuthProvider = {
    id: "hosted-test-gateway",
    async authenticate(request) {
        const subject = request.headers["test-verified-identity"];

        return typeof subject === "string" ? { subject, name: subject } : undefined;
    },
};

before(async () => {
    for (const basePath of mounts) {
        const model = scriptedModel();

        apps.push(
            await PocketApp.open({
                basePath,
                dataDir: join(root, basePath.slice(1)),
                defaultCwd: work,
                supervised: false,
                log: () => {},
                home,
                configureModels: (models) => models.registerNativeProvider(model.provider),
            }),
        );
    }

    const handlers: ReturnType<typeof createHandler>[] = [];

    gateway = createServer((request, response) => {
        // This replaces the already-verified gateway identity. It is not a production trust mechanism.
        delete request.headers["test-verified-identity"];

        if (identity !== undefined) {
            request.headers["test-verified-identity"] = identity;
        }

        const mount = mounts.findIndex((prefix) => request.url?.startsWith(prefix + "/"));

        if (mount < 0) {
            response.writeHead(404);
            response.end();

            return;
        }

        void handlers[mount]!(request, response);
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;

    for (const [index, owner] of [alice, bob].entries()) {
        handlers.push(
            createHandler({
                app: apps[index]!,
                externalAuth: new ExternalAuth(provider, {
                    owner,
                    guests: [owner === alice ? bob : alice],
                    origin: base,
                }),
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
    }
});

after(async () => {
    await browsers?.closeAll({ final: true });
    gateway?.closeAllConnections();
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));

    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

test("one verified identity is its own owner and a separate native guest on another prefix", async () => {
    const own = await (await fetch(base + mounts[0] + "/api/me")).json();
    const other = await (await fetch(base + mounts[1] + "/api/me")).json();

    assert.equal(own.user.role, "owner");
    assert.equal(other.user.role, "guest");
    assert.notEqual(own.user.id, other.user.id);
    assert.equal(own.server.authenticationMode, "external");
    assert.equal(other.server.authenticationMode, "external");
    assert.equal(
        (
            await (
                await fetch(base + mounts[1] + "/api/me", {
                    headers: { cookie: "pocket_auth=foreign-instance-cookie" },
                })
            ).json()
        ).user.id,
        other.user.id,
    );
    const mutation = (origin: string) => ({
        method: "POST",
        headers: { "x-pocket": "1", "content-type": "application/json", origin },
        body: JSON.stringify({ name: "Alice in Bob's Pocket" }),
    });

    assert.equal(
        (await fetch(base + mounts[1] + "/api/me", mutation("https://hostile.example"))).status,
        403,
    );
    assert.equal((await fetch(base + mounts[1] + "/api/me", mutation(base))).status, 200);
    apps[1]!.removeUser(
        apps[1]!.config.users.find((user) => user.role === "owner")!,
        other.user.id,
    );
    assert.equal((await fetch(base + mounts[1] + "/api/me")).status, 403);
    assert.equal((await fetch(base + mounts[0] + "/api/me")).status, 200);
});

test("both mounted app shells, resources and PWA manifests stay inside their own prefix", async () => {
    identity = bob;

    for (const mount of mounts) {
        const page = await fetch(base + mount + "/");

        assert.equal(page.status, 200);
        const html = await page.text();

        assert.ok(html.includes(mount), "server supplies the immutable browser mount");

        for (const path of ["/app.js", "/store.js", "/style.css", "/sw.js"]) {
            assert.equal((await fetch(base + mount + path)).status, 200, mount + path);
        }

        const manifest = await (await fetch(base + mount + "/manifest.webmanifest")).json();

        assert.equal(manifest.scope, mount + "/");
        assert.equal(manifest.start_url, mount + "/");
        assert.equal(manifest.id, mount + "/");
        assert.equal(manifest.share_target.action, mount + "/share");
        assert.ok(
            manifest.icons.every((icon: { src: string }) => icon.src.startsWith(mount + "/")),
        );
        assert.equal((await fetch(base + mount + "/join/unused")).status, 403);
        assert.equal((await fetch(base + mount + "/login?token=unused")).status, 403);
    }

    assert.equal((await fetch(base + "/api/me")).status, 404);
    identity = undefined;

    for (const mount of mounts) {
        for (const path of ["/", "/app.js", "/sw.js", "/api/me", "/pub/token"]) {
            assert.equal(
                (
                    await fetch(base + mount + path, {
                        headers: { authorization: `Bearer ${apps[0]!.config.ownerToken}` },
                    })
                ).status,
                403,
            );
        }
    }
});

test(
    "a real browser opens two prefixes without pairing and keeps browser state and API identity separate",
    { skip: findBrowser() === undefined ? "no Chromium-based browser" : false },
    async () => {
        identity = bob;
        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "hosted-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);
        const errors: string[] = [];

        for (const [index, mount] of mounts.entries()) {
            await page.navigate(base + mount + "/");
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(`
                            const { store } = await import(${JSON.stringify(mount + "/store.js")});
                            return JSON.stringify(store.state.me?.role === ${JSON.stringify(index === 0 ? "guest" : "owner")});
                        `),
                    ) === true,
                "external identity and live bootstrap at " + mount,
            );
            const result = JSON.parse(
                await page.evaluate(`
                    const { localStore, sessionStore, appUrl } = await import(${JSON.stringify(mount + "/base-path.js")});
                    const previous = localStore.getItem("hosted-instance-test");
                    localStore.setItem("hosted-instance-test", ${JSON.stringify(mount)});
                    sessionStore.setItem("hosted-instance-test", ${JSON.stringify(mount)});
                    const me = await (await fetch(appUrl("/api/me"))).json();
                    return JSON.stringify({ previous, role: me.user.role, name: me.user.name, local: localStore.getItem("hosted-instance-test"), session: sessionStore.getItem("hosted-instance-test") });
                `),
            );

            assert.equal(result.previous, null, "another mount's storage is not reused");
            assert.equal(result.role, index === 0 ? "guest" : "owner");
            assert.equal(result.local, mount);
            assert.equal(result.session, mount);
            errors.push(
                ...page
                    .logs()
                    .filter((entry) => entry.level === "error")
                    .map((entry) => entry.text),
            );
        }

        await page.navigate(base + mounts[0] + "/");
        assert.equal(
            JSON.parse(
                await page.evaluate(`
                    const { localStore } = await import(${JSON.stringify(mounts[0] + "/base-path.js")});
                    return JSON.stringify(localStore.getItem("hosted-instance-test"));
                `),
            ),
            mounts[0],
        );
        assert.deepEqual(errors, []);
    },
);
