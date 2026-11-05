/** Required, startup-loaded authentication providers. Unlike extensions, these cannot be hot-disabled. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigStore, User } from "./config.ts";
import { HttpError } from "./errors.ts";

/** A verified full identity, never a display name or a request-supplied role. */
export interface AuthPrincipal {
    subject: string;
    name?: string;
}

/** Experimental startup API, independent of the optional Pocket extension loader. Runs as the Unix owner. */
export interface AuthProvider {
    /** Stable identity namespace. Changing it creates different bindings. */
    id: string;
    authenticate(request: IncomingMessage, signal: AbortSignal): Promise<AuthPrincipal | undefined>;
}

export interface ExternalAuthPolicy {
    owner: string;
    /** Explicit opt-in to native guest access (steering, Unix-owner commands, all sessions initially). */
    guests: readonly string[];
    /** Public browser origin, independent of untrusted Host / forwarding headers. */
    origin: string;
}

/** Read an admin/owner-owned regular file without following a symlink; other Unix accounts get no access. */
export function readAuthFile(file: string): string {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        const stat = fstatSync(fd);

        if (
            !stat.isFile() ||
            stat.size > 64 * 1024 ||
            (stat.mode & 0o077) !== 0 ||
            (stat.uid !== 0 && stat.uid !== process.getuid?.())
        ) {
            throw new Error(
                "Authentication files must be restricted owner/admin-owned regular files",
            );
        }

        return readFileSync(fd, "utf8");
    } finally {
        closeSync(fd);
    }
}

/** Bound both startup and request authentication. Provider failures never expose their words or credentials. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    try {
        return await Promise.race([
            Promise.resolve().then(() => run(abort.signal)),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    abort.abort();
                    reject(new Error("Authentication timed out"));
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        abort.abort();
    }
}

export class ExternalAuth {
    readonly #provider: AuthProvider;
    readonly #policy: ExternalAuthPolicy;
    readonly #timeoutMs: number;
    readonly #people = new WeakMap<IncomingMessage, string>();

    constructor(provider: AuthProvider, policy: ExternalAuthPolicy, timeoutMs = 5000) {
        if (
            typeof provider?.id !== "string" ||
            provider.id.length === 0 ||
            typeof provider.authenticate !== "function" ||
            typeof policy.owner !== "string" ||
            policy.owner.length === 0 ||
            !Array.isArray(policy.guests) ||
            !policy.guests.every((subject) => typeof subject === "string" && subject.length > 0) ||
            new URL(policy.origin).origin !== policy.origin
        ) {
            throw new Error("Invalid external authentication configuration");
        }

        this.#provider = provider;
        this.#policy = { ...policy, guests: [...policy.guests] };
        this.#timeoutMs = timeoutMs;
    }

    /** Called before *any* dispatcher branch, even app files, capabilities, hooks and sign-in pages. */
    async admit(request: IncomingMessage, config: ConfigStore): Promise<void> {
        this.#people.delete(request);
        let principal: AuthPrincipal | undefined;

        try {
            principal = await bounded(
                (signal) => this.#provider.authenticate(request, signal),
                this.#timeoutMs,
            );
        } catch {
            throw new HttpError(503, "External authentication unavailable");
        }

        if (
            typeof principal?.subject !== "string" ||
            principal.subject.length === 0 ||
            (principal.subject !== this.#policy.owner &&
                !this.#policy.guests.includes(principal.subject))
        ) {
            throw new HttpError(403, "External identity not admitted");
        }

        // X-Pocket alone is not an Origin check when an upstream authenticates every browser request.
        const origin = request.headers.origin;
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");

        if (
            (origin !== undefined && origin !== this.#policy.origin) ||
            request.headers["sec-fetch-site"] === "cross-site" ||
            (mutation && origin !== this.#policy.origin)
        ) {
            throw new HttpError(403, "Use Pi Pocket's configured origin");
        }

        const user = config.externalUser(
            this.#provider.id,
            principal.subject,
            principal.subject === this.#policy.owner,
            principal.name,
        );

        if (user === undefined) {
            throw new HttpError(403, "External identity revoked");
        }

        this.#people.set(request, user.id);
    }

    /** Re-resolve native access every time; neither cookies nor provider metadata can restore a former role. */
    user(request: IncomingMessage, config: ConfigStore): User | undefined {
        const id = this.#people.get(request);

        return id === undefined ? undefined : config.userById(id);
    }
}

/** PI_POCKET_AUTH_CONFIG selects a required provider before the server listens. Unset keeps native pairing. */
export async function loadExternalAuth(
    file: string | undefined,
): Promise<ExternalAuth | undefined> {
    if (file === undefined) {
        return undefined;
    }

    try {
        return await bounded(async (signal) => {
            const config = JSON.parse(readAuthFile(resolve(file))) as ExternalAuthPolicy & {
                module: string;
                options?: unknown;
            };
            const module = await import(
                pathToFileURL(resolve(dirname(resolve(file)), config.module)).href
            );
            const provider: AuthProvider = await module.default(config.options, signal);

            return new ExternalAuth(provider, config);
        }, 5000);
    } catch {
        throw new Error("Could not initialize required external authentication provider");
    }
}
