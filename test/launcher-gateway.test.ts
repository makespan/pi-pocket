// Behind a gateway (`--socket`, or external authentication with PI_POCKET_AUTH_CONFIG) the launcher never runs
// `tailscale serve`: Serve's mount is the whole node's (`--https=443 --set-path=/`), so making one, or taking down a
// stale one, would replace the gateway's own route on the host. A fake tailscale on PATH logs every command it is given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serveAllowed } from "../src/launcher/access.ts";

// Short and without symlinks: the socket path is limited to about 100 bytes.
const root = mkdtempSync(join(realpathSync(tmpdir()), "ppg-"));
const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));
const fakeDir = join(root, "fake-bin");
const calls = join(root, "tailscale-calls.log");
const secret = randomBytes(32).toString("base64url");

after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(fakeDir);
writeFileSync(
    join(fakeDir, "tailscale"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\necho '{}'\n`,
    { mode: 0o755 },
);

/** Every command the fake tailscale was given, one line each. */
const tailscaleCalls = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];

/** The bundled Tailscale provider, as the hosting guide configures it. */
function externalAuthConfig(): string {
    const secretFile = join(root, "gateway-secret");
    const config = join(root, "auth.json");

    writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
    writeFileSync(
        config,
        JSON.stringify({
            module: fileURLToPath(
                new URL("../src/server/auth-providers/tailscale.ts", import.meta.url),
            ),
            options: { secretFile },
            owner: "alice@example.com",
            origin: "https://pocket.example.com",
        }),
        { mode: 0o600 },
    );

    return config;
}

async function freePort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return port;
}

/**
 * A data folder whose last run chose Tailscale Serve and left the receipt of a mount for `port`: what makes a launcher
 * adopt the mode, and clear the stale mount with `tailscale serve … off`, when serve is allowed.
 */
function servedBefore(name: string, port: number): string {
    const data = join(root, name);

    mkdirSync(data, { mode: 0o700 });
    writeFileSync(join(data, "launcher.json"), JSON.stringify({ access: "tailscale-serve" }));
    writeFileSync(join(data, "serve-mount.json"), JSON.stringify({ port }));

    return data;
}

/** Run the launcher with the fake tailscale first on PATH, until `done` matches its output or it exits. */
async function launch(
    args: string[],
    data: string,
    env: Record<string, string>,
    done: RegExp,
): Promise<{ output: string; code: number | null }> {
    const base: NodeJS.ProcessEnv = { ...process.env };

    for (const key of ["PI_POCKET_AUTH_CONFIG", "PI_POCKET_SOCKET", "PI_POCKET_ACCESS"]) {
        delete base[key];
    }

    const proc = spawn(process.execPath, [launcher, "--data", data, "--cwd", root, ...args], {
        env: {
            ...base,
            PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ""}`,
            PI_CODING_AGENT_DIR: join(data, "agent"),
            PI_POCKET_GUARD: "off",
            PI_POCKET_SUPERVISED: "",
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = once(proc, "exit") as Promise<[number | null]>;
    const seen = new Promise<void>((resolve) => {
        const take = (chunk: Buffer) => {
            output += chunk;

            if (done.test(output)) {
                resolve();
            }
        };

        proc.stdout.on("data", take);
        proc.stderr.on("data", take);
    });

    await Promise.race([seen, exited]);

    if (proc.exitCode === null) {
        proc.kill("SIGTERM");
    }

    const [code] = await exited;

    return { output, code };
}

test("serve is allowed only when the launcher is not behind a gateway", () => {
    assert.equal(serveAllowed({ socket: undefined, externalAuth: false }), true);
    assert.equal(serveAllowed({ socket: "/run/pocket/alice.sock", externalAuth: false }), false);
    assert.equal(serveAllowed({ socket: undefined, externalAuth: true }), false);
    assert.equal(serveAllowed({ socket: "/run/pocket/alice.sock", externalAuth: true }), false);
});

test(
    "behind a gateway the launcher runs no tailscale serve: not to mount, not to adopt, not to clear a stale mount",
    { timeout: 120_000, skip: process.platform === "win32" ? "a shell script stands in" : false },
    async () => {
        const config = externalAuthConfig();
        const socketFolder = join(root, "sock");

        mkdirSync(socketFolder);
        chmodSync(socketFolder, 0o750);
        const socket = join(socketFolder, "p.sock");

        // A socket with external authentication, the hosted setup, even with Serve asked for by the environment.
        const onSocket = await launch(
            ["--socket", socket],
            servedBefore("socket-data", 8787),
            { PI_POCKET_AUTH_CONFIG: config, PI_POCKET_ACCESS: "tailscale-serve" },
            /use your authenticated gateway/,
        );

        assert.deepEqual(tailscaleCalls(), [], "socket with external authentication");
        assert.match(onSocket.output, /Gateway \(Unix socket\)/, onSocket.output);
        assert.match(onSocket.output, /does not run tailscale serve/);

        // A socket in pairing mode.
        const pairing = await launch(
            ["--socket", socket],
            servedBefore("pairing-data", 8787),
            {},
            /Sign in .*\n/,
        );

        assert.deepEqual(tailscaleCalls(), [], "socket in pairing mode");
        assert.match(pairing.output, /Gateway \(Unix socket\)/, pairing.output);

        // External authentication on TCP, asking for Serve: refused before anything runs.
        const port = await freePort();
        const asked = await launch(
            ["--access", "tailscale-serve", "--port", String(port)],
            servedBefore("asked-data", port),
            { PI_POCKET_AUTH_CONFIG: config },
            /not available behind a gateway/,
        );

        assert.deepEqual(
            tailscaleCalls(),
            [],
            "--access tailscale-serve with external authentication",
        );
        assert.match(asked.output, /not available behind a gateway/, asked.output);
        assert.notEqual(asked.code, 0);

        // External authentication on TCP in another mode, with the receipt of a stale mount on this very port: told,
        // not cleared, and the start goes on.
        const local = await launch(
            ["--access", "local", "--port", String(port)],
            servedBefore("local-data", port),
            { PI_POCKET_AUTH_CONFIG: config },
            /use your authenticated gateway/,
        );

        assert.deepEqual(tailscaleCalls(), [], "another mode with external authentication");
        assert.match(local.output, /does not run tailscale serve/, local.output);
        assert.match(local.output, /use your authenticated gateway/, local.output);
    },
);
