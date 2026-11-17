// Run the actual classic worker with fake browser capabilities: a notification must never select a sibling mount.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function worker(basePath: string) {
    const origin = "https://pocket.example";
    const handlers = new Map<string, (event: unknown) => void>();
    const focused: string[] = [];
    const navigated: string[] = [];
    const opened: string[] = [];
    const posted: unknown[] = [];
    const fetched: string[] = [];
    const notifications: { icon: string; data: { url: string } }[] = [];
    const client = (path: string) => ({
        url: origin + path,
        focus: async () => {
            focused.push(path);
        },
        navigate: async (url: string) => {
            navigated.push(url);
        },
        postMessage: (message: unknown) => {
            posted.push(message);
        },
    });
    const clients = [client("/someone.else/s/2"), client(basePath + "/s/1")];

    runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), {
        URL,
        self: {
            registration: {
                scope: origin + basePath + "/",
                showNotification: async (
                    _title: string,
                    options: { icon: string; data: { url: string } },
                ) => {
                    notifications.push(options);
                },
            },
            location: { origin },
            navigator: {},
            clients: {
                matchAll: async () => clients,
                openWindow: async (url: string) => {
                    opened.push(url);
                },
            },
            addEventListener: (name: string, handler: (event: unknown) => void) =>
                handlers.set(name, handler),
        },
        fetch: async (url: string) => {
            fetched.push(url);

            return { ok: true };
        },
    });

    const dispatch = async (name: string, properties: Record<string, unknown>) => {
        let done: Promise<unknown> | undefined;

        handlers.get(name)!({
            ...properties,
            waitUntil: (promise: Promise<unknown>) => {
                done = promise;
            },
        });
        await done;
    };

    const click = (url: string, extra: Record<string, unknown> = {}) =>
        dispatch("notificationclick", {
            notification: { close: () => {}, data: { url, ...extra } },
        });

    return {
        origin,
        focused,
        navigated,
        opened,
        posted,
        fetched,
        notifications,
        clients,
        dispatch,
        click,
    };
}

for (const basePath of ["", "/julian.rath", "/team/jakob.auer"]) {
    test(`sw.js uses ${basePath || "root"} for notification resources, approval API and window targeting`, async () => {
        const w = worker(basePath);

        // Root-only installations retain their existing behavior. A mounted worker sees a sibling before its own window.
        if (basePath === "") {
            w.clients.shift();
        }

        await w.dispatch("push", { data: { json: () => ({ title: "Done" }) } });
        assert.equal(w.notifications[0]!.icon, basePath + "/icon.svg");
        assert.equal(w.notifications[0]!.data.url, basePath + "/");
        await w.click(basePath + "/s/12");
        assert.deepEqual(w.focused, [basePath + "/s/1"]);
        assert.deepEqual(w.navigated, [w.origin + basePath + "/s/12"]);
        assert.deepEqual(w.opened, []);
        await w.click(basePath + "/?pip=1");
        assert.equal(w.posted.length, 1);
        assert.equal(w.navigated.length, 1);
        await w.dispatch("notificationclick", {
            action: "allow",
            notification: {
                close: () => {},
                data: { url: basePath + "/", approval: { id: "approve-me" } },
            },
        });
        assert.deepEqual(w.fetched, [basePath + "/api/approvals/approve-me"]);

        if (basePath !== "") {
            await w.click("/someone.else/s/3");
            await w.click("https://outside.example" + basePath + "/");
            assert.equal(w.focused.length, 2);
            w.clients.splice(1, 1);
            await w.click(basePath + "/s/13");
            assert.deepEqual(w.opened, [w.origin + basePath + "/s/13"]);
            assert.equal(w.focused.length, 2);
        }
    });
}
