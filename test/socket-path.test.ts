// `--socket`: the server listens on a Unix socket in an administrator-made folder instead of a TCP port that another
// Unix user could take while the server restarts (and so receive the gateway's per-instance secret).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Short and without symlinks (macOS's tmpdir is under /var, a symlink): socket paths are limited to about 100 bytes.
const root = mkdtempSync(join(realpathSync(tmpdir()), "pps-"));
const main = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));
const secret = randomBytes(32).toString("base64url");
const guestCapability = "example.com/cap/pi-pocket";

after(() => rmSync(root, { recursive: true, force: true }));

/** A folder as an administrator would make it: owned by this user, writable by no one else. */
function socketFolder(name: string, mode = 0o750): string {
    const folder = join(root, name);

    mkdirSync(folder);
    chmodSync(folder, mode);

    return folder;
}

/** The bundled Tailscale provider, admitting guests by app capability as the hosting guide configures it. */
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
            guestCapability,
            origin: "https://pocket.example.com",
        }),
        { mode: 0o600 },
    );

    return config;
}

/** The test's environment, without the options under test unless `extra` sets them (an empty one is a path). */
function environment(data: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: join(data, "agent"),
        PI_POCKET_GUARD: "off",
        PI_POCKET_SUPERVISED: "",
    };

    for (const key of ["PI_POCKET_AUTH_CONFIG", "PI_POCKET_SOCKET", "PI_POCKET_ACCESS"]) {
        delete env[key];
    }

    return { ...env, ...extra };
}

function start(name: string, args: string[], env: Record<string, string> = {}, ipc = false) {
    const data = join(root, `${name}-data`);
    const proc = spawn(process.execPath, [main, "--data", data, "--cwd", root, ...args], {
        env: environment(data, { PI_POCKET_LAUNCHER: ipc ? "1" : "", ...env }),
        stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    let output = "";

    proc.stdout!.on("data", (chunk) => (output += chunk));
    proc.stderr!.on("data", (chunk) => (output += chunk));
    const exited = once(proc, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

    return { proc, data, exited, output: () => output };
}

async function ready(started: ReturnType<typeof start>): Promise<Record<string, unknown>> {
    const [message] = await Promise.race([
        once(started.proc, "message"),
        started.exited.then(() => {
            throw new Error(`Server exited before ready: ${started.output()}`);
        }),
    ]);

    return message as Record<string, unknown>;
}

async function stop(started: ReturnType<typeof start>): Promise<void> {
    if (started.proc.exitCode === null) {
        started.proc.kill("SIGTERM");
        await started.exited;
    }
}

function overSocket(
    socketPath: string,
    path: string,
    headers: Record<string, string> = {},
    body?: { method: string; text: string },
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const sent = request({ socketPath, path, headers, method: body?.method }, (response) => {
            let body = "";

            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode!, body }));
        });

        sent.on("error", reject);
        sent.end(body?.text);
    });
}

/** A socket file that no server answers on, as a killed server leaves behind. */
function staleSocket(path: string): void {
    const made = spawnSync(process.execPath, [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
    ]);

    assert.equal(made.status, 0, String(made.stderr));
    assert.ok(lstatSync(path).isSocket());
}

test(
    "a prefixed, externally authenticated server serves HTTP on its socket, opens it to the group (0660), and removes it on stop",
    { timeout: 60_000 },
    async () => {
        const socket = join(socketFolder("ok"), "pocket.sock");
        const started = start(
            "ok",
            ["--socket", socket, "--base-path", "/alice.name"],
            { PI_POCKET_AUTH_CONFIG: externalAuthConfig() },
            true,
        );

        try {
            const message = await ready(started);

            assert.equal(message.type, "ready");
            assert.equal(message.socket, socket);
            assert.equal(message.host, undefined);
            assert.equal(message.port, undefined);
            assert.equal(message.loginPath, undefined);
            assert.equal(lstatSync(socket).mode & 0o777, 0o660);
            const gateway = {
                "x-pocket-gateway-secret": secret,
                "tailscale-user-login": "alice@example.com",
            };
            const me = await overSocket(socket, "/alice.name/api/me", gateway);

            assert.equal(me.status, 200);
            assert.equal(JSON.parse(me.body).user.role, "owner");
            assert.equal(JSON.parse(me.body).server.authenticationMode, "external");
            assert.equal((await overSocket(socket, "/alice.name/", gateway)).status, 200);
            assert.equal((await overSocket(socket, "/api/me", gateway)).status, 404);
            assert.equal(
                (
                    await overSocket(socket, "/alice.name/api/me", {
                        "tailscale-user-login": "alice@example.com",
                    })
                ).status,
                403,
            );
            // As Tailscale Serve and Caddy forward to a socket: Host is localhost, the public host is forwarded. The
            // pinned origin decides, never one made from Host.
            const forwarded = {
                ...gateway,
                host: "localhost",
                "x-forwarded-host": "pocket.example.com",
                "x-forwarded-proto": "https",
            };
            const rename = (origin: string) =>
                overSocket(
                    socket,
                    "/alice.name/api/me",
                    {
                        ...forwarded,
                        origin,
                        "x-pocket": "1",
                        "content-type": "application/json",
                    },
                    { method: "POST", text: JSON.stringify({ name: "Alice" }) },
                );

            assert.equal((await rename("https://pocket.example.com")).status, 200);
            assert.equal((await rename("http://localhost")).status, 403);
            assert.equal(
                (
                    await overSocket(socket, "/alice.name/s/1", {
                        ...forwarded,
                        "sec-fetch-site": "cross-site",
                        "sec-fetch-mode": "navigate",
                        "sec-fetch-dest": "document",
                    })
                ).status,
                200,
            );
            // What Serve with --accept-app-caps and Caddy pass on for Bob, a member of the granted group.
            const bob = (capabilities: string, gatewaySecret = secret) => ({
                ...forwarded,
                "x-pocket-gateway-secret": gatewaySecret,
                "tailscale-user-login": "bob@example.com",
                "tailscale-user-name": "Bob",
                "tailscale-app-capabilities": capabilities,
            });
            const granted = JSON.stringify({ [guestCapability]: [{ role: "guest" }] });
            const guest = await overSocket(socket, "/alice.name/api/me", bob(granted));

            assert.equal(guest.status, 200);
            assert.equal(JSON.parse(guest.body).user.role, "guest");
            assert.equal(
                JSON.parse((await overSocket(socket, "/alice.name/api/me", bob(granted))).body).user
                    .id,
                JSON.parse(guest.body).user.id,
            );
            assert.equal((await overSocket(socket, "/alice.name/api/me", bob("{}"))).status, 403);
            assert.equal(
                (
                    await overSocket(
                        socket,
                        "/alice.name/api/me",
                        bob(granted, randomBytes(32).toString("base64url")),
                    )
                ).status,
                403,
                "a forged capability without the gateway's secret",
            );
            assert.doesNotMatch(started.output(), /http:\/\//);
        } finally {
            await stop(started);
        }

        assert.equal(existsSync(socket), false);
    },
);

test("refuses a socket folder that its group or others may write, before opening the data", async () => {
    for (const mode of [0o770, 0o757, 0o1777]) {
        const name = `w${mode.toString(8)}`;
        const socket = join(socketFolder(name, mode), "pocket.sock");
        const started = start(name, ["--socket", socket]);
        const [code] = await started.exited;

        assert.equal(code, 78, started.output());
        assert.match(started.output(), /must not be writable by its group or others/);
        assert.equal(existsSync(socket), false);
        assert.equal(existsSync(join(started.data, "pocket.sqlite")), false);
    }
});

test("refuses a symlinked socket folder, and a path through one", async () => {
    const real = socketFolder("real");
    const link = join(root, "link");

    symlinkSync(real, link);

    const started = start("link", ["--socket", join(link, "pocket.sock")]);

    assert.equal((await started.exited)[0], 78, started.output());
    assert.match(started.output(), /must be a real folder, not a symlink/);
    assert.equal(existsSync(join(real, "pocket.sock")), false);

    mkdirSync(join(real, "inner"), { mode: 0o750 });
    const through = start("through", ["--socket", join(link, "inner", "pocket.sock")]);

    assert.equal((await through.exited)[0], 78, through.output());
    assert.match(through.output(), /must be a real folder, not a symlink/);
});

test("never removes or follows anything at the path that is not a socket", async () => {
    const folder = socketFolder("taken");
    const file = join(folder, "file.sock");
    const target = join(root, "target.txt");

    writeFileSync(file, "keep me");
    writeFileSync(target, "keep me too");
    mkdirSync(join(folder, "dir.sock"));
    symlinkSync(target, join(folder, "link.sock"));

    for (const name of ["file.sock", "dir.sock", "link.sock"]) {
        const started = start(`taken-${name}`, ["--socket", join(folder, name)]);
        const [code] = await started.exited;

        assert.equal(code, 78, started.output());
        assert.match(started.output(), /exists and is not a socket/);
    }

    assert.equal(readFileSync(file, "utf8"), "keep me");
    assert.ok(lstatSync(join(folder, "dir.sock")).isDirectory());
    assert.ok(lstatSync(join(folder, "link.sock")).isSymbolicLink());
    assert.equal(readFileSync(target, "utf8"), "keep me too");
});

test(
    "replaces a stale socket, but not one that a server answers on",
    { timeout: 60_000 },
    async () => {
        const folder = socketFolder("stale");
        const socket = join(folder, "pocket.sock");

        staleSocket(socket);
        const before = lstatSync(socket).ino;
        // PI_POCKET_SOCKET is the same option as --socket.
        const started = start("stale", [], { PI_POCKET_SOCKET: socket }, true);

        try {
            assert.equal((await ready(started)).socket, socket);
            assert.notEqual(lstatSync(socket).ino, before);
            assert.equal(lstatSync(socket).mode & 0o777, 0o660);
            assert.equal((await overSocket(socket, "/api/me")).status, 401);
            const second = start("stale-second", ["--socket", socket]);

            assert.equal((await second.exited)[0], 78, second.output());
            assert.match(second.output(), /already in use/);
            assert.equal(
                (await overSocket(socket, "/api/me")).status,
                401,
                "the first still serves",
            );
        } finally {
            await stop(started);
        }
    },
);

test("socket options: absolute paths only, never mixed with a TCP address, and TCP stays the default", async () => {
    const socket = join(root, "x.sock");
    const server = (args: string[]) => start("args", args).exited.then(([code]) => code);

    assert.notEqual(await server(["--socket", "relative.sock"]), 0);
    assert.notEqual(await server(["--socket", socket, "--port", "9999"]), 0);
    assert.notEqual(await server(["--socket", socket, "--host", "127.0.0.1"]), 0);

    const launcherOptions = (args: string[], env: Record<string, string> = {}) =>
        spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { parseArgs } from './src/launcher/options.ts'; const o = parseArgs(${JSON.stringify(args)}); console.log(JSON.stringify({ socket: o.socket ?? null, port: o.port }));`,
            ],
            { env: environment(root, env), encoding: "utf8" },
        );

    assert.equal(launcherOptions([]).stdout.trim(), '{"socket":null,"port":8787}');
    assert.equal(
        launcherOptions([], { PI_POCKET_SOCKET: socket }).stdout.trim(),
        JSON.stringify({ socket, port: 8787 }),
    );
    assert.equal(
        launcherOptions(["--socket", socket]).stdout.trim(),
        JSON.stringify({ socket, port: 8787 }),
    );

    for (const args of [
        ["--socket", "relative.sock"],
        ["--socket", `${root}/../x.sock`],
        ["--socket", socket, "--port", "9999"],
        ["--socket", socket, "--host", "127.0.0.1"],
        ["--socket", socket, "--access", "lan"],
    ]) {
        const result = launcherOptions(args);

        assert.equal(result.status, 1, args.join(" "));
        assert.match(result.stderr, /--socket/);
    }
});

test(
    "a TCP server still reports its host and port, and no socket",
    { timeout: 60_000 },
    async () => {
        const probe = createNetServer();

        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const port = (probe.address() as { port: number }).port;

        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const started = start("tcp", ["--port", String(port)], {}, true);

        try {
            const message = await ready(started);

            assert.equal(message.host, "127.0.0.1");
            assert.equal(message.port, port);
            assert.equal(message.socket, undefined);
            assert.match(String(message.loginPath), /^\/login\?token=/);
            assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
        } finally {
            await stop(started);
        }
    },
);

test(
    "the launcher in pairing mode on a socket prints the sign-in path, and no http link",
    { timeout: 60_000 },
    async () => {
        const socket = join(socketFolder("launcher"), "pocket.sock");
        const data = join(root, "launcher-data");
        const proc = spawn(
            process.execPath,
            [launcher, "--socket", socket, "--data", data, "--cwd", root],
            { env: environment(data), stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        const exited = once(proc, "exit");
        // The panel's sign-in row comes once the server is ready.
        const panel = new Promise<void>((resolve, reject) => {
            const take = (chunk: Buffer) => {
                output += chunk;

                if (/Sign in .*\n/.test(output)) {
                    resolve();
                }
            };

            proc.stdout.on("data", take);
            proc.stderr.on("data", take);
            void exited.then(() => reject(new Error(`Launcher exited: ${output}`)));
        });

        try {
            await panel;
            assert.match(output, /Gateway \(Unix socket\)/);
            assert.match(output, /Sign in +\/login\?token=\S+ on your gateway's address/);
            assert.doesNotMatch(output, /http:\/\/|https:\/\//);
            assert.equal((await overSocket(socket, "/api/me")).status, 401);
        } finally {
            proc.kill("SIGTERM");
            await exited;
        }

        assert.equal(existsSync(socket), false);
    },
);
