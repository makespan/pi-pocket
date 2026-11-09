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
const guestCapability = "example.com/cap/pi-pocket";
let identity: string | undefined = alice;
/** Whether the tailnet grants the verified person the guest capability (both are in the granted group). */
let capabilityGranted = true;
let apps: App[] = [];
let gateway: Server;
let base = "";
let browsers: Browsers | undefined;
/** Requests that reached the gateway outside every mount: a browser that leaks a root-relative address. */
const outside: string[] = [];
/** Every request the gateway received, as `METHOD /path?query`. */
const requests: string[] = [];
const provider: AuthProvider = {
    id: "hosted-test-gateway",
    async authenticate(request) {
        const subject = request.headers["test-verified-identity"];
        const capabilities: Record<string, unknown[]> = capabilityGranted
            ? { [guestCapability]: [{ role: "guest" }] }
            : {};

        return typeof subject === "string" ? { subject, name: subject, capabilities } : undefined;
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

        requests.push(`${request.method} ${request.url}`);

        if (mount < 0) {
            outside.push(`${request.method} ${request.url}`);
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
                // No guest list: the capability admits the other developer as a guest.
                externalAuth: new ExternalAuth(provider, { owner, guestCapability, origin: base }),
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
    capabilityGranted = false;
    assert.equal((await fetch(base + mounts[1] + "/api/me")).status, 403, "left the group");
    assert.equal((await fetch(base + mounts[0] + "/api/me")).status, 200, "still owner");
    capabilityGranted = true;
    assert.equal((await (await fetch(base + mounts[1] + "/api/me")).json()).user.id, other.user.id);
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
        outside.length = 0;
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
        assert.deepEqual(outside, [], "no request leaves the mounts");
        assert.deepEqual(errors, []);
    },
);

test(
    "a real browser on a mounted, externally authenticated instance uses 0.28's fetching UI without a request outside its mount",
    { skip: findBrowser() === undefined ? "no Chromium-based browser" : false },
    async () => {
        const mount = mounts[0];

        identity = alice;
        outside.length = 0;
        browsers ??= new Browsers({
            dataDir: mkdtempSync(join(root, "hosted-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(2);
        const inPage = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script)) as T;
        const fetched = () =>
            inPage<string[]>(
                `return JSON.stringify(performance.getEntriesByType("resource").map((each) => new URL(each.name).pathname));`,
            );

        await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
        await page.navigate(base + mount + "/");
        await until(
            () =>
                inPage<boolean>(`
                    const { store } = await import(${JSON.stringify(mount + "/store.js")});
                    return JSON.stringify(store.state.me?.role === "owner" && store.state.connection === "open");
                `),
            "the owner, signed in by the gateway, with a live connection",
        );
        // The board asks every two seconds: past the browser's default 250 entries, later ones would go unlisted.
        await page.evaluate(`performance.setResourceTimingBufferSize(100000); return "{}";`);

        // The Running now board asks the server for what runs, every two seconds while it shows.
        await page.evaluate(`
            const { openRunning } = await import(${JSON.stringify(mount + "/store.js")});
            openRunning();
            return "{}";
        `);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".running-board") !== null);`,
                )) && (await fetched()).includes(mount + "/api/running/board"),
            "the Running now board, from this mount's API",
        );

        // Diagrams and math: the built-in diagrams client loads Pele, KaTeX, and KaTeX's stylesheet and fonts lazily.
        await until(
            () =>
                inPage<boolean>(`
                    const markdown = await import(${JSON.stringify(mount + "/markdown-ext.js")});
                    return JSON.stringify(["mermaid", "math"].every((lang) => markdown.fenceFor(lang)));
                `),
            "the diagrams client's fences",
        );
        await page.evaluate(`
            const markdown = await import(${JSON.stringify(mount + "/markdown-ext.js")});
            const { h, render } = await import("preact");
            for (const [lang, source] of [["mermaid", "flowchart LR\\n  A --> B"], ["math", "x^2 + \\\\sqrt{y}"]]) {
                const host = document.body.appendChild(document.createElement("div"));
                host.className = "hosted-fence-" + lang;
                render(h(markdown.fenceFor(lang).component, { source, lang, streaming: false }), host);
            }
            return "{}";
        `);
        await until(async () => {
            const paths = await fetched();

            return ["/vendor/pele.mjs", "/vendor/katex.mjs", "/vendor/katex.css"].every((path) =>
                paths.includes(mount + path),
            );
        }, "Pele, KaTeX and its stylesheet, from this mount");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".hosted-fence-math .katex") !== null && document.querySelector(".hosted-fence-mermaid svg") !== null);`,
                ),
            "the rendered diagram and formula",
        );

        // The home-screen icon in the owner's colors: its address, its cookie, and the colors the owner's browser reports.
        const icon = await inPage<{ link: string; cookie: string }>(`
            const { applyIcons, reportIconsAs } = await import(${JSON.stringify(mount + "/app-icon.js")});
            reportIconsAs(true);
            applyIcons({ "--o-bg-darker": "#202030", "--o-orange": "#ff8800" });
            return JSON.stringify({
                link: document.querySelector('link[rel="apple-touch-icon"]').getAttribute("href"),
                cookie: document.cookie,
            });
        `);

        assert.ok(icon.link.startsWith(mount + "/app-icon.png?"), icon.link);
        assert.match(icon.cookie, /(^|; )pocket_icon~alice\.name=/, icon.cookie);
        assert.doesNotMatch(icon.cookie, /(^|; )pocket_icon=/, "no root icon cookie");
        await until(
            async () => requests.includes(`PUT ${mount}/api/app-icon`),
            "the owner's icon colors, sent to this mount",
        );
        // The manifest and the home-screen page carry the colors of this mount's cookie, at this mount's addresses.
        const manifest = await inPage<{ icons: { src: string }[]; theme_color: string }>(`
            return JSON.stringify(await (await fetch(${JSON.stringify(mount + "/manifest.webmanifest")})).json());
        `);

        assert.equal(manifest.theme_color, "#202030");
        assert.ok(
            manifest.icons.every((each) => each.src.startsWith(mount + "/app-icon.png?")),
            JSON.stringify(manifest.icons),
        );

        // An avatar's address (`avatar.js`), made without fetching it.
        const avatar = await inPage<string>(`
            const { avatarSrc } = await import(${JSON.stringify(mount + "/avatar.js")});
            return JSON.stringify(avatarSrc({ id: "someone", avatar: 3 }));
        `);

        assert.ok(avatar.startsWith(mount + "/api/avatar/"), avatar);

        // What the browser keeps for mounted instances is under their prefix only: Web Storage keys and databases.
        const kept = await inPage<{ keys: string[]; databases: string[] }>(`
            return JSON.stringify({
                keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)],
                databases: (await indexedDB.databases()).map((each) => each.name),
            });
        `);

        assert.ok(kept.keys.length > 0, JSON.stringify(kept));
        assert.deepEqual(
            [...kept.keys, ...kept.databases].filter(
                (key) => !mounts.some((each) => key.startsWith(`pocket@${each}:`)),
            ),
            [],
            "no unscoped browser state",
        );

        const paths = await fetched();

        assert.deepEqual(
            paths.filter((path) => !path.startsWith(mount + "/")),
            [],
            "every resource the page fetched is this mount's",
        );
        assert.deepEqual(outside, [], "no request reached the gateway outside the mounts");
    },
);
