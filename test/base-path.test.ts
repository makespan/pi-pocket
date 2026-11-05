// Mount routing and generated addresses, with root and two independent instances behind one prefix-preserving proxy.
import { cleanUp, context, home, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { appPath, loginNext, parseBasePath, requestPath } from "../src/base-path.ts";
import { PocketApp } from "../src/server/app.ts";
import { authCookieName } from "../src/server/auth.ts";
import { importProblems } from "../src/server/gallery/share.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";

const mounts = ["", "/julian.rath", "/team/jakob.auer"];
const apps: PocketApp[] = [];
let server: Server;
let origin = "";
let browsers: Browsers | undefined;

before(async () => {
    for (const [index, basePath] of mounts.entries()) {
        const dataDir = join(root, `base-path-${index}`);
        const model = scriptedModel();

        mkdirSync(join(dataDir, "extensions"), { recursive: true });
        writeFileSync(
            join(dataDir, "extensions", "mount.ts"),
            `/** Mount test. */
export default (_host, web) => {
    web.route("GET", "status", () => ({ ok: true }));
    web.client("mount.js");
    web.publicPage(({ link }) => '<form method="post"><p>' + link.path + '</p></form>');
};`,
        );
        writeFileSync(
            join(dataDir, "extensions", "mount.js"),
            `
import { basePath, appUrl } from "#pocket/base-path";
export const pocketApi = 1;
export default () => { globalThis.mountExtension = appUrl("/api/x/mount/status"); };`,
        );
        const app = await PocketApp.open({
            basePath,
            dataDir,
            defaultCwd: work,
            supervised: false,
            home,
            log: () => {},
            configureModels: (models) => models.registerNativeProvider(model.provider),
        });

        apps.push(app);
        await app.setExtensionEnabled(owner(app), "mount.ts", true);

        if (index === 1) {
            await app.setExtensionEnabled(owner(app), "design.ts", true);
        }
    }

    const handlers = apps.map((app) =>
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );

    server = createServer((req, res) => {
        // This proxy intentionally preserves the entire request target. Root is the fallback instance.
        const index = mounts.findIndex((mount) => mount !== "" && req.url?.startsWith(mount + "/"));

        void handlers[index < 0 ? 0 : index]!(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();

    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

function call(app: PocketApp, path: string, body?: unknown) {
    return fetch(origin + app.url(path), {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("base paths accept dotted usernames, normalize only root, and reject ambiguous mount spellings", () => {
    for (const path of ["", "/", "/julian.rath", "/team/jakob.auer", "/a_b-c.1"]) {
        assert.equal(parseBasePath(path), path === "/" ? "" : path);
    }

    for (const path of [
        "alice",
        "//alice",
        "/alice/",
        "/.",
        "/..",
        "/a/../b",
        "/a/./b",
        "/a%2fb",
        "/a\\b",
        "/a?b",
        "/a#b",
        "/a b",
    ]) {
        assert.throws(() => parseBasePath(path), /--base-path/);
    }

    assert.equal(appPath("/julian.rath", "/s/12"), "/julian.rath/s/12");
    assert.equal(
        requestPath("/julian.rath/julian.rath/api/me", "/julian.rath"),
        "/julian.rath/api/me",
    );
    assert.equal(requestPath("/julian.rath/api/me?path=/a/../b", "/julian.rath"), "/api/me");

    for (const path of [
        "/",
        "/api/me",
        "/julian.rath",
        "/julian.rath-other/api/me",
        "/%6aulian.rath/api/me",
        "/julian.rath//api/me",
        "/julian.rath/a/../api/me",
        "/julian.rath/%2e/api/me",
        "/julian.rath/%2E%2e/api/me",
        "/julian.rath/a%2fb",
        "/julian.rath/a%5cb",
        "/julian.rath/%252e%252e/api/me",
        "/julian.rath/%25252fapi",
        "/julian.rath/%00",
        "/julian.rath/%",
        "https://example.com/julian.rath/",
    ]) {
        assert.equal(requestPath(path, "/julian.rath"), undefined, path);
        assert.equal(loginNext(path, "/julian.rath"), "/julian.rath/", path);
    }

    assert.equal(loginNext("/julian.rath/s/12?chat=1", "/julian.rath"), "/julian.rath/s/12?chat=1");
    assert.equal(
        loginNext("/julian.rath/s/12?chat=1#turn-3", "/julian.rath"),
        "/julian.rath/s/12?chat=1#turn-3",
    );
    assert.equal(loginNext("//evil.example/", ""), "/");
    assert.equal(loginNext("/julian.rath/?x=\r\n", "/julian.rath"), "/julian.rath/");
});

test("gallery sharing accepts the public base-path helper but not core-only import-map aliases", () => {
    const check = (name: string) =>
        importProblems(
            "mount",
            [{ name: "mount.js", text: `import { appUrl } from "${name}";` }],
            new Set(),
        );

    assert.deepEqual(check("#pocket/base-path"), []);
    assert.match(check("#pocket/store")[0]!, /which Pi Pocket does not have/);
    assert.match(check("#pocket/artifact-bridge")[0]!, /which Pi Pocket does not have/);
});

test("quick tunnel pinning uses only this mount's cookie, not a sibling root cookie", async () => {
    const app = apps[1]!;
    const mounted = app.config.addUser("Mounted guest", "guest");
    const tunnel = "mounted-guest.trycloudflare.com";
    const response = await fetch(origin + app.url("/api/me"), {
        headers: {
            cookie: `${authCookieName(app.basePath)}=${mounted.token}; pocket_auth=foreign-root-cookie`,
            "x-forwarded-host": tunnel,
        },
    });

    assert.equal(response.status, 200);
    assert.equal(app.config.userById(mounted.user.id)?.tunnel, tunnel);
    const bearer = app.config.addUser("Bearer guest", "guest");

    assert.equal(
        (
            await fetch(origin + app.url("/api/me"), {
                headers: {
                    authorization: `Bearer ${bearer.token}`,
                    cookie: "pocket_auth=foreign-root-cookie",
                    "x-forwarded-host": tunnel,
                },
            })
        ).status,
        200,
    );
    assert.equal(app.config.userById(bearer.user.id)?.tunnel, undefined);
});

test("launcher reads the environment, lets the flag override it, and fails before launch on invalid paths", () => {
    const run = (args: string[], value: string) =>
        spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { parseArgs } from './src/launcher/options.ts'; console.log(JSON.stringify(parseArgs(${JSON.stringify(args)}).basePath));`,
            ],
            { env: { ...process.env, PI_POCKET_BASE_PATH: value }, encoding: "utf8" },
        );

    assert.equal(run([], "/julian.rath").stdout.trim(), '"/julian.rath"');
    assert.equal(
        run(["--base-path", "/team/jakob.auer"], "/invalid/").stdout.trim(),
        '"/team/jakob.auer"',
    );
    assert.equal(run(["--base-path", "/"], "/julian.rath").stdout.trim(), '""');
    assert.equal(run([], "/bad/").status, 1);
    assert.match(run(["--base-path"], "").stderr, /needs a value/);
});

test("root and mounted pages have prefix-aware assets, import maps, CSP hashes, manifests and theme CSS", async () => {
    for (const app of apps) {
        const response = await fetch(origin + app.url("/s/12"));
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.ok(!html.includes("__POCKET_BASE"));
        assert.ok(html.includes(`src="${app.url("/app.js")}"`));
        assert.ok(html.includes(`href="${app.url("/base-path.js")}"`));
        assert.ok(html.includes(`"#pocket/base-path": "${app.url("/base-path.js")}"`));

        for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
            const hash = createHash("sha256")
                .update(match[1]!.replace(/\r\n?/g, "\n"))
                .digest("base64");

            assert.ok(
                response.headers.get("content-security-policy")?.includes(`'sha256-${hash}'`),
            );
        }

        for (const path of [
            "/app.js",
            "/base-path.js",
            "/vendor/preact.mjs",
            "/style.css",
            "/fonts/Geist.woff2",
            "/sw.js",
        ]) {
            assert.equal((await fetch(origin + app.url(path))).status, 200, app.url(path));
        }

        const manifest = await (await fetch(origin + app.url("/manifest.webmanifest"))).json();

        assert.equal(manifest.id, app.url("/"));
        assert.equal(manifest.scope, app.url("/"));
        assert.equal(manifest.start_url, app.url("/"));
        assert.equal(manifest.share_target.action, app.url("/share"));
        assert.ok(
            manifest.icons.every((icon: { src: string }) => icon.src.startsWith(app.url("/"))),
        );
        const theme = app.themes.list(true).find((item) => item.css.length > 0)!;

        assert.ok(theme.css.every((path) => path.startsWith(app.url("/themes/"))));
        const css = await (await call(app, theme.css[0]!.slice(app.basePath.length))).text();

        assert.ok(!/url\("\/(?!team\/|julian\.rath\/)/.test(css) || app.basePath === "");
        const login = await fetch(origin + app.url("/login?token=invalid"));

        assert.ok((await login.text()).includes(`href="${app.url("/style.css")}"`));
    }
});

test("raw paths cannot escape a mount or smuggle encoded separators through the dispatcher", async () => {
    const app = apps[1]!;
    const isolated = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => isolated.listen(0, "127.0.0.1", resolve));

    try {
        for (const path of [
            "/",
            "/api/me",
            "/julian.rath-other/api/me",
            "/julian.rath/api%2fme",
            "/julian.rath/a/../api/me",
            "/julian.rath/%2e%2e/api/me",
            "/julian.rath/%252fapi/me",
            "/julian.rath//api/me",
            "/julian.rath/julian.rath/api/me",
        ]) {
            const status = await new Promise<number>((resolve, reject) => {
                const req = request(
                    {
                        host: "127.0.0.1",
                        port: (isolated.address() as { port: number }).port,
                        path,
                    },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode!);
                    },
                );

                req.on("error", reject);
                req.end();
            });

            assert.equal(status, 404, path);
        }
    } finally {
        isolated.closeAllConnections();
        isolated.close();
    }
});

test("login, next, logout and invite cookies remain scoped, and root keeps pocket_auth", async () => {
    const cookies: string[] = [];

    for (const app of apps) {
        const next = app.url("/s/12?chat=1");
        const login = await fetch(
            origin +
                app.url(`/login?token=${app.config.ownerToken}&next=${encodeURIComponent(next)}`),
            { redirect: "manual" },
        );
        const set = login.headers.get("set-cookie")!;
        const cookie = set.split(";", 1)[0]!;

        cookies.push(cookie);
        assert.equal(login.headers.get("location"), next);
        assert.ok(cookie.startsWith(authCookieName(app.basePath) + "="));
        assert.ok(set.includes(`Path=${app.url("/")};`));
        const me = await fetch(origin + app.url("/api/me"), { headers: { cookie } });

        assert.equal(me.status, 200);
        assert.equal((await me.json()).user.id, owner(app).id);
        const invalid = await fetch(
            origin +
                app.url(
                    `/login?token=${app.config.ownerToken}&next=${encodeURIComponent(app.basePath === "" ? "//evil.example/" : "/someone-else/s/12")}`,
                ),
            { redirect: "manual" },
        );

        assert.equal(invalid.headers.get("location"), app.url("/"));
        const inviteResponse = await call(app, "/api/invite", { role: "guest" });
        const invite = await inviteResponse.json();

        assert.equal(invite.url, origin + app.url(`/join/${invite.code}`));
        const joined = await fetch(invite.url, {
            method: "POST",
            body: "name=Mounted",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });

        assert.equal(joined.headers.get("location"), app.url("/"));
        assert.ok(joined.headers.get("set-cookie")?.includes(`Path=${app.url("/")};`));
        const logout = await call(app, "/api/logout", {});

        assert.ok(
            logout.headers.get("set-cookie")?.startsWith(authCookieName(app.basePath) + "=;"),
        );
        assert.ok(logout.headers.get("set-cookie")?.includes(`Path=${app.url("/")};`));
    }

    assert.ok(cookies[0]!.startsWith("pocket_auth="));

    for (const [index, app] of apps.entries()) {
        const other = cookies.filter((_, cookieIndex) => cookieIndex !== index).join("; ");

        assert.equal(
            (await fetch(origin + app.url("/api/sessions"), { headers: { cookie: other } })).status,
            401,
        );
    }
});

test("poll, SSE, extension modules, public links and artifact bundle capabilities retain the mount", async () => {
    for (const app of apps) {
        const poll = await (await call(app, "/api/poll?tab=mount-test&p=5")).json();

        assert.ok(poll.events.some((event: { event: string }) => event.event === "hello"));
        const module = app.webs.clients(owner(app)).find((item) => item.module === "mount")!;

        assert.ok(module.url.startsWith(app.url("/x/mount/")));
        assert.equal(
            (
                await fetch(origin + module.url, {
                    headers: { authorization: `Bearer ${app.config.ownerToken}` },
                })
            ).status,
            200,
        );
        assert.equal((await call(app, "/api/x/mount/status")).status, 200);
        const link = await app.publicLinks.create("mount", { hours: 1 });

        assert.equal(link.path, app.url(`/l/${link.token}`));
        assert.equal((await fetch(origin + link.path)).status, 200);
        const abort = new AbortController();
        const events = await fetch(origin + app.url("/api/events?tab=mount-stream&p=5"), {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
            signal: abort.signal,
        });
        const reader = events.body!.getReader();
        let text = "";

        while (!text.includes("event: hello")) {
            const chunk = await reader.read();

            assert.equal(chunk.done, false);
            text += new TextDecoder().decode(chunk.value);
        }

        assert.match(text, /event: hello/);
        abort.abort();
        await reader.cancel().catch(() => {});
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        const { id } = await app.commands.createSession(owner(app), { cwd: work });
        const tool = createArtifacts({} as PocketHost).tools![0]!;

        await tool.execute(
            {
                id: "demo",
                title: "Demo",
                content:
                    '<!doctype html><link rel="stylesheet" href="assets/style.css"><p>mounted</p>',
                assets: [{ name: "assets/style.css", content: "p{color:red}" }],
            } as never,
            {
                conversationId: id,
                taskId: 1000,
                callId: "mount-artifact",
                agent: async () => ({ cwd: work }),
                snapshot: app.harness.snapshot.bind(app.harness),
                commit: app.harness.commit.bind(app.harness),
            } as never,
            context,
        );
        const page = await (await call(app, `/a/${id}/demo/1`)).text();
        const assetBase = /<base href="([^"]+)"/.exec(page)![1]!;

        assert.ok(assetBase.startsWith(origin + app.url(`/a/${id}/demo/`)));
        assert.equal((await fetch(assetBase + "assets/style.css")).status, 200);
        const share = await app.shares.create(id, owner(app), { id: "demo" });
        const publicPage = await (await fetch(origin + share.path)).text();

        assert.equal(share.path, app.url(`/pub/${share.token}`));
        assert.ok(publicPage.includes(`<base href="${origin}${share.path}/"`));
        assert.equal((await fetch(origin + share.path + "/assets/style.css")).status, 200);
    }
});

test(
    "one browser keeps two instances signed in, isolates state and PWA shares, and uses scoped live updates",
    { skip: findBrowser() === undefined ? "no Chromium" : false },
    async () => {
        browsers = new Browsers({
            dataDir: join(root, "base-path-browser"),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);
        const evaluate = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script)) as T;

        for (const app of apps.slice(1)) {
            await page.navigate(origin + app.url(`/login?token=${app.config.ownerToken}`));
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify((await import(${JSON.stringify(app.url("/store.js"))})).store.state.me?.role === "owner" && globalThis.mountExtension === ${JSON.stringify(app.url("/api/x/mount/status"))});`,
                    ),
                "mounted browser signed in",
            );
            const state = await evaluate<{
                base: string;
                writable: boolean;
                path: string;
                scope: string;
            }>(`
            const helpers = await import("#pocket/base-path");
            helpers.localStore.setItem("mount-test", helpers.basePath);
            helpers.sessionStore.setItem("mount-test", helpers.basePath);
            const registration = await navigator.serviceWorker.register(helpers.appUrl("/sw.js"), { scope: helpers.appUrl("/") });
            await navigator.serviceWorker.ready;
            return JSON.stringify({ base: helpers.basePath, writable: Object.getOwnPropertyDescriptor(globalThis, "POCKET_BASE_PATH").writable, path: location.pathname, scope: registration.scope });
        `);

            assert.deepEqual(state, {
                base: app.basePath,
                writable: false,
                path: app.url("/"),
                scope: origin + app.url("/"),
            });

            if (app === apps[1]) {
                const design = app.webs
                    .clients(owner(app))
                    .find((item) => item.module === "design")!;
                const moduleUrl = new URL("app.js", origin + design.url).href;

                assert.equal(
                    await evaluate<boolean>(`
                    await import(${JSON.stringify(moduleUrl)});
                    return JSON.stringify((await import("#pocket/store")).store.state.me.role === "owner");
                `),
                    true,
                );
            }

            await page.navigate(origin + app.url("/"));
            await until(
                async () =>
                    evaluate<boolean>(
                        "return JSON.stringify(navigator.serviceWorker.controller !== null);",
                    ),
                "scoped worker controls page",
            );
            const shared = await evaluate<{ path: string; text: string; caches: string[] }>(`
            const helpers = await import("#pocket/base-path");
            const form = new FormData();
            form.set("text", "shared at " + helpers.basePath);
            const response = await fetch(helpers.appUrl("/share"), { method: "POST", body: form });
            const url = new URL(response.url);
            const value = await (await import(helpers.appUrl("/share.js"))).takeShare(url.searchParams.get("share"));
            return JSON.stringify({ path: url.pathname, text: value.text, caches: await caches.keys() });
        `);

            assert.equal(shared.path, app.url("/"));
            assert.equal(shared.text, "shared at " + app.basePath);
            assert.ok(!shared.caches.includes(`pocket@${app.basePath}:pocket-share`));
        }

        for (const app of apps.slice(1)) {
            await page.navigate(origin + app.url("/"));
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify((await import(${JSON.stringify(app.url("/store.js"))})).store.state.me?.role === "owner");`,
                    ),
                "cookie survived the other instance",
            );
            const state = await evaluate<{
                local: string;
                session: string;
                keys: string[];
                registered: string[];
            }>(`
            const h = await import("#pocket/base-path");
            return JSON.stringify({ local: h.localStore.getItem("mount-test"), session: h.sessionStore.getItem("mount-test"), keys: Array.from({ length: h.localStore.length }, (_, i) => h.localStore.key(i)), registered: (await navigator.serviceWorker.getRegistrations()).map(r => r.scope) });
        `);

            assert.equal(state.local, app.basePath);
            assert.equal(state.session, app.basePath);
            assert.ok(state.keys.includes("mount-test"));
            assert.ok(state.registered.includes(origin + apps[1]!.url("/")));
            assert.ok(state.registered.includes(origin + apps[2]!.url("/")));
            const name = `Live ${app.basePath}`;
            const { id } = await app.commands.createSession(owner(app), { cwd: work });

            await app.commands.updateSession(id, owner(app), { title: name });
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify((await import(${JSON.stringify(app.url("/store.js"))})).store.state.sessions.some(s => s.title === ${JSON.stringify(name)}));`,
                    ),
                "SSE reaches the right instance",
            );
            await evaluate(
                `(await import(${JSON.stringify(app.url("/store.js"))})).navigate(${id}); return "null";`,
            );
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify(location.pathname === ${JSON.stringify(app.url(`/s/${id}`))});`,
                    ),
                "prefixed deep link",
            );
        }
    },
);
