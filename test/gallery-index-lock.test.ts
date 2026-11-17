// The gallery's index, pinned by an administrator with PI_POCKET_GALLERY_INDEX: the owner cannot change it in the app.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";

const PINNED = "admin/pinned-index";
const SAVED = `${JSON.stringify({ index: "owner/own-index" })}\n`;

after(cleanUp);

/** Open the app on a data folder whose gallery saved the owner's own index, with the variable set to `value`. */
async function openPinned(name: string, value: string) {
    const dataDir = join(root, name);

    mkdirSync(join(dataDir, "gallery"), { recursive: true });
    writeFileSync(join(dataDir, "gallery", "settings.json"), SAVED);
    process.env.PI_POCKET_GALLERY_INDEX = value;

    try {
        return { app: await openApp(scriptedModel(), dataDir), dataDir };
    } finally {
        delete process.env.PI_POCKET_GALLERY_INDEX;
    }
}

test("a pinned index is the one read, and the owner's saved index is not", async () => {
    const { app } = await openPinned("gallery-pinned", ` ${PINNED} `);
    const read: string[] = [];

    app.gallery.fetch = async (url) => {
        read.push(url);

        return new Response(JSON.stringify({ format: 1, extensions: [] }));
    };

    try {
        assert.equal((await app.gallery.listing(true)).address, PINNED);
        assert.deepEqual(read, [`https://raw.githubusercontent.com/${PINNED}/HEAD/index.json`]);
        assert.deepEqual(await app.gallery.settings(), {
            index: PINNED,
            default: "TannerMidd/pi-pocket-extensions",
            locked: true,
        });
    } finally {
        await app.close();
    }
});

test("the owner cannot change a pinned index, and nothing is written", async () => {
    const { app, dataDir } = await openPinned("gallery-pinned-set", PINNED);

    try {
        await assert.rejects(app.gallery.setIndex("someone/else"), {
            status: 403,
            message: "The administrator set the gallery's index (PI_POCKET_GALLERY_INDEX).",
        });
        assert.equal(readFileSync(join(dataDir, "gallery", "settings.json"), "utf8"), SAVED);
        assert.equal((await app.gallery.settings()).index, PINNED);
    } finally {
        await app.close();
    }
});

test("a pinned index the gallery cannot use stops the start, rather than fall back to another index", async () => {
    await assert.rejects(
        openPinned("gallery-pinned-bad", "http://example.com/index.json"),
        /PI_POCKET_GALLERY_INDEX/,
    );
});
