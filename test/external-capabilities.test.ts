// External identity remains required for opaque-origin artifact assets and public-link forms.
import { cleanUp, context, home, root, scriptedModel, work, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ExternalAuth, type AuthProvider } from "../src/server/auth-provider.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");
const mount = "/owner.name";
const login = "owner@example.com";
const verified = { "test-identity": login };
const opaque = { ...verified, origin: "null", "sec-fetch-site": "cross-site" };
let app: App;
let server: Server;
let base = "";
let signed = "";
let published = "";
const provider: AuthProvider = {
    id: "capability-test",
    async authenticate(request) {
        return request.headers["test-identity"] === login ? { subject: login } : undefined;
    },
};

before(async () => {
    const dataDir = join(root, "opaque-capabilities");

    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "opaque-form.ts"),
        `/** A capability form fixture. */
export default (_host, web) => {
    web.publicPage((request) => request.method === "GET"
        ? '<form method="post"><input name="answer"><button>Answer</button></form>'
        : '<p>answer: ' + request.form.answer + '</p>');
};`,
    );
    const model = scriptedModel();

    app = await PocketApp.open({
        basePath: mount,
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(model.provider),
    });
    const owner = app.config.users.find((person) => person.role === "owner")!;

    await app.setExtensionEnabled(owner, "opaque-form.ts", true);
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id: session } = await app.commands.createSession(owner, { cwd: work });
    const tools = createArtifacts({} as PocketHost).tools!;

    await tools[0]!.execute(
        {
            id: "bundle",
            title: "Bundle",
            content:
                '<!doctype html><link rel="stylesheet" href="assets/style.css"><h1>Bundle</h1>',
            assets: [{ name: "assets/style.css", content: "body{color:green}" }],
        } as never,
        {
            conversationId: session,
            taskId: 9876,
            callId: "opaque-fixture",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
    let handler: ReturnType<typeof createHandler>;

    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    handler = createHandler({
        app,
        externalAuth: new ExternalAuth(provider, { owner: login, guests: [], origin: base }),
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const html = await (
        await fetch(`${base}${mount}/a/${session}/bundle/1`, { headers: verified })
    ).text();

    signed = /<base href="([^"]+)">/.exec(html)![1]!;
    published = (await app.shares.create(session, owner, { id: "bundle", version: 1 })).path;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
});

test("opaque signed/public assets work, but no API, unsigned asset or forged capability gains an origin exception", async () => {
    for (const url of [signed + "assets/style.css", base + published + "/assets/style.css"]) {
        const response = await fetch(url, { headers: opaque });

        assert.equal(response.status, 200, url);
        assert.equal(await response.text(), "body{color:green}");
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.equal(
            (await fetch(url, { headers: { origin: "null", "sec-fetch-site": "cross-site" } }))
                .status,
            403,
            "a capability cannot replace external identity",
        );
        assert.equal(
            (await fetch(url, { headers: { ...opaque, origin: "https://hostile.example" } }))
                .status,
            403,
        );
    }

    const unsigned = signed.replace(/\/1~[^/]+\//, "/1/") + "assets/style.css";
    const invalid = signed.replace(/\/1~/, "/2~") + "assets/style.css";

    for (const url of [unsigned, invalid, base + mount + "/api/me"]) {
        assert.equal((await fetch(url, { headers: opaque })).status, 403, url);
    }
});

test("opaque urlencoded capability forms submit, while API and non-form mutations stay protected", async () => {
    const link = await app.publicLinks.create("opaque-form", { hours: 1, uses: 1 });
    const post = {
        method: "POST",
        headers: { ...opaque, "content-type": "application/x-www-form-urlencoded" },
        body: "answer=accepted",
    };
    const response = await fetch(base + link.path, post);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<p>answer: accepted</p>");
    assert.equal(
        (await fetch(base + link.path, post)).status,
        404,
        "one-use admission is retained",
    );
    assert.equal((await fetch(base + mount + "/api/me", post)).status, 403);
    assert.equal(
        (
            await fetch(base + link.path, {
                ...post,
                headers: { ...opaque, "content-type": "application/json" },
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await fetch(base + link.path, {
                ...post,
                headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
            })
        ).status,
        403,
    );
});
