import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pp-auth-startup-"));
const main = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));

after(() => rmSync(root, { recursive: true, force: true }));

async function freePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;

    await new Promise<void>((resolve) => probe.close(() => resolve()));

    return port;
}

function start(name: string, config: string, port: number, ipc = false) {
    const data = join(root, name);
    const proc = spawn(
        process.execPath,
        [main, "--port", String(port), "--data", data, "--cwd", root],
        {
            env: {
                ...process.env,
                PI_POCKET_AUTH_CONFIG: config,
                PI_CODING_AGENT_DIR: join(data, "agent"),
                PI_POCKET_GUARD: "off",
                PI_POCKET_LAUNCHER: ipc ? "1" : "",
                PI_POCKET_SUPERVISED: "",
            },
            stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        },
    );
    let output = "";

    proc.stdout!.on("data", (chunk) => {
        output += chunk;
    });
    proc.stderr!.on("data", (chunk) => {
        output += chunk;
    });

    return { proc, data, output: () => output };
}

test("missing required provider exits before listening/opening database and does not disclose config details", async () => {
    const port = await freePort();
    const { proc, data, output } = start("missing", join(root, "secret-config-path"), port);
    const [code] = await once(proc, "exit");

    assert.equal(code, 78);
    assert.match(output(), /Could not initialize required external authentication provider/);
    assert.doesNotMatch(output(), /secret-config-path|token=|ownerToken/);
    assert.equal(existsSync(join(data, "pocket.sqlite")), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test(
    "external startup IPC has no owner login path; app requires provider even with an owner bearer",
    { timeout: 30000 },
    async () => {
        const module = join(root, "provider.mjs");
        const config = join(root, "config.json");

        writeFileSync(
            module,
            'export default () => ({ id: "startup", async authenticate() { return undefined; } })',
            { mode: 0o600 },
        );
        writeFileSync(
            config,
            JSON.stringify({
                module,
                owner: "owner@example.com",
                guests: [],
                origin: "https://pocket.example.com",
            }),
            { mode: 0o600 },
        );
        const port = await freePort();
        const { proc, data, output } = start("valid", config, port, true);
        const exited = once(proc, "exit");

        try {
            const [ready] = await Promise.race([
                once(proc, "message"),
                exited.then(() => {
                    throw new Error("Server exited before ready: " + output());
                }),
            ]);

            assert.equal(ready.type, "ready");
            assert.equal(ready.loginPath, undefined);
            assert.equal(ready.externalAuth, true);
            const token = JSON.parse(readFileSync(join(data, "config.json"), "utf8")).ownerToken;
            const response = await fetch(`http://127.0.0.1:${port}/`, {
                headers: { authorization: `Bearer ${token}` },
            });

            assert.equal(response.status, 403);
            assert.doesNotMatch(output(), new RegExp(token));
            assert.doesNotMatch(output(), /token=|Scan to sign in/);
        } finally {
            proc.kill("SIGTERM");
            await exited;
        }
    },
);
