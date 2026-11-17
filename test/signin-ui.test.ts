// The sign-in screen of a mounted instance, in a real browser: an owner link copied with another address of the same
// server (localhost instead of 127.0.0.1, or a LAN address) still signs in, on the address the browser is on.
import { cleanUp, home, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: PocketApp;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let port = 0;

before(async () => {
    if (real.skip) {
        return;
    }

    const model = scriptedModel();

    app = await PocketApp.open({
        basePath: "/alice.name",
        dataDir: join(root, "signin-ui"),
        defaultCwd: work,
        supervised: false,
        home,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "signin-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a pasted owner link with another address of this server signs in here", real, async () => {
    const here = `http://127.0.0.1:${port}`;

    await page.navigate(here + app.url("/"));
    await until(
        async () =>
            (await page.evaluate(
                `return JSON.stringify(document.querySelector('[data-part="sign-in"] input') !== null)`,
            )) === "true",
        "the sign-in screen",
    );
    const pasted = `http://localhost:${port}${app.url(`/login?token=${encodeURIComponent(app.config.ownerToken)}`)}`;

    await page.evaluate(`
        const input = document.querySelector('[data-part="sign-in"] input');

        input.value = ${JSON.stringify(pasted)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        document.querySelector('[data-part="sign-in"] button').click();
        return "null";
    `);
    await until(async () => {
        try {
            return (
                (await page.evaluate(
                    `return JSON.stringify((await import(${JSON.stringify(app.url("/store.js"))})).store.state.me?.role ?? null)`,
                )) === '"owner"'
            );
        } catch {
            // The page is navigating.
            return false;
        }
    }, "signed in as the owner");

    assert.equal(JSON.parse(await page.evaluate("return JSON.stringify(location.origin)")), here);
});
