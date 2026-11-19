// Makespan's fork: buttons that extensions put beside the mic and Send (`composerButton` with `side: "end"`), in a real
// Chromium, through a drop-in: they show only while the box holds text (`whenText`), their `run` gets the box, and
// `set` empties it so the draft is gone too. A left button keeps its place and also gets the box.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const dropIns = join(root, "data", "extensions");

/** "Take it": beside Send, only with text; it keeps the text and empties the box. "Look": on the left, always. */
const BUTTONS_JS = `export default (pocket) => {
    globalThis.makespan = pocket.makespan;
    pocket.composerButton({
        id: "take", title: "Take it", icon: "pulse", side: "end", whenText: true,
        run(box) { globalThis.taken = box.text; box.set(""); },
    });
    pocket.composerButton({
        id: "look", title: "Look", icon: "pulse",
        run(box) { globalThis.looked = box?.text ?? null; },
    });
};
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const typeInBox = (text: string) =>
    inPage(`
        const box = document.querySelector(".composer textarea");
        box.focus();
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

/** Where a button is: in the row's right part (after the gap), on its left, or not there. */
const placeOf = (title: string) =>
    inPage<string>(`
        const button = document.querySelector('.composer-row button[title=${JSON.stringify(title)}]');
        if (!button) return JSON.stringify("none");
        const grow = document.querySelector(".composer-row .grow");
        return JSON.stringify(grow.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING ? "end" : "start");
    `);

const click = (title: string) =>
    inPage(
        `document.querySelector('.composer-row button[title=${JSON.stringify(title)}]').click(); return "null";`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "buttons.ts"),
        `/** Buttons: beside Send. */\nexport default (_host, web) => { web.client("buttons.js", { access: "view" }); };\n`,
    );
    writeFileSync(join(dropIns, "buttons.js"), BUTTONS_JS);
    app = await openApp(scriptedModel());
    session = await newSession(app);
    await app.setExtensionEnabled(owner(app), "buttons.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-buttons-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector('.composer-row button[title="Look"]')))`,
            ),
        "the buttons' browser module",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the fork tells a module so", real, async () => {
    assert.deepEqual(await inPage(`return JSON.stringify(globalThis.makespan)`), {
        composerBox: true,
    });
});

test(
    "a button beside Send shows only with text; its run gets the box and can empty it",
    real,
    async () => {
        assert.equal(await placeOf("Take it"), "none", "no text: not there");
        await typeInBox("fork this, please");
        await until(async () => (await placeOf("Take it")) === "end", "the button beside Send");
        await click("Take it");
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(globalThis.taken ?? "")`)) !== "",
            "the button's run",
        );
        assert.equal(
            await inPage<string>(`return JSON.stringify(globalThis.taken)`),
            "fork this, please",
        );
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector(".composer textarea").value)`,
                )) === "",
            "the box emptied",
        );
        await until(
            async () => (await placeOf("Take it")) === "none",
            "the button gone with the text",
        );
    },
);

test("a button on the left stays there, and its run gets the box too", real, async () => {
    assert.equal(await placeOf("Look"), "start");
    await typeInBox("a look");
    await click("Look");
    await until(
        async () =>
            (await inPage<string>(`return JSON.stringify(globalThis.looked ?? "")`)) === "a look",
        "the left button's run with the box",
    );
});
