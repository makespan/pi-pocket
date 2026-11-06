/**
 * The server's Unix socket listener (`--socket`). Its folder is the security boundary: an administrator makes it, owned
 * by the instance's user (or root) and writable by nobody else, so no other Unix user can take the address while the
 * server restarts, as one can take a free TCP port.
 */
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

/** The socket cannot be used as configured. The message names paths only, never credentials. */
export class SocketPathError extends Error {}

/** The socket file this process listens on, to remove on shutdown only while it is still that file. */
export interface OwnSocket {
    path: string;
    dev: number;
    ino: number;
}

/** Validate `--socket` / `PI_POCKET_SOCKET`. Empty means unset, as for the other environment options. */
export function parseSocketPath(value: string | undefined): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (process.platform === "win32") {
        throw new SocketPathError("--socket needs a Unix system");
    }

    if (!isAbsolute(value) || normalize(value) !== value || value.endsWith("/")) {
        throw new SocketPathError(
            "--socket must be an absolute, normalized file path (no . or .. segments)",
        );
    }

    return value;
}

/**
 * Check the folder, and remove a stale socket that no server answers on, before listening. Refuses a folder that is a
 * symlink or reached through one, is owned by another user, or that its group or others may write; and refuses any
 * entry at the path that is not a socket (it never follows a symlink or deletes another kind of file).
 */
export async function prepareSocketPath(path: string): Promise<void> {
    const folder = dirname(path);
    let stat;

    try {
        stat = lstatSync(folder);
    } catch (error) {
        throw new SocketPathError(
            `The socket folder ${folder} is not usable (${(error as NodeJS.ErrnoException).code}). An administrator creates it.`,
        );
    }

    if (!stat.isDirectory() || realpathSync(folder) !== folder) {
        throw new SocketPathError(
            `The socket folder ${folder} must be a real folder, not a symlink or a path through one.`,
        );
    }

    if (stat.uid !== process.getuid!() && stat.uid !== 0) {
        throw new SocketPathError(
            `The socket folder ${folder} must be owned by this user or root.`,
        );
    }

    if ((stat.mode & 0o022) !== 0) {
        throw new SocketPathError(
            `The socket folder ${folder} must not be writable by its group or others (for example mode 2750).`,
        );
    }

    let entry;

    try {
        entry = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }

        throw error;
    }

    if (!entry.isSocket()) {
        throw new SocketPathError(`${path} exists and is not a socket: remove it by hand.`);
    }

    if (await answers(path)) {
        throw Object.assign(new Error(`${path} is in use`), { code: "EADDRINUSE" });
    }

    // Only this user and root can change entries in the checked folder, so the entry is still the stale socket.
    unlinkSync(path);
}

/** Whether a server accepts connections on the socket at `path`. */
function answers(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const probe = connect({ path });

        probe.once("connect", () => {
            probe.destroy();
            resolve(true);
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
            probe.destroy();

            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                resolve(false);
            } else {
                reject(error);
            }
        });
    });
}

/** After listening: check the new file is this process's socket, and open it to the folder's group (the gateway). */
export function claimSocket(path: string): OwnSocket {
    const stat = lstatSync(path);

    if (!stat.isSocket() || stat.uid !== process.getuid!()) {
        throw new SocketPathError(`${path} is not the socket this server made.`);
    }

    chmodSync(path, 0o660);

    return { path, dev: stat.dev, ino: stat.ino };
}

/** Remove the socket file if it is still this process's own (closing the server usually removed it already). */
export function releaseSocket(own: OwnSocket | undefined): void {
    if (own === undefined) {
        return;
    }

    try {
        const stat = lstatSync(own.path);

        if (stat.isSocket() && stat.dev === own.dev && stat.ino === own.ino) {
            unlinkSync(own.path);
        }
    } catch {
        // Already gone.
    }
}
