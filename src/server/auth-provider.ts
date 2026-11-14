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
    /** Verified capability grants for this subject (name → values), such as Tailscale app capabilities. */
    capabilities?: Record<string, unknown[]>;
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
    guests?: readonly string[];
    /**
     * Also admit, as a native guest, any subject whose principal holds this capability with a
     * `{ "role": "guest" }` value. Checked on every request; the owner never needs it.
     */
    guestCapability?: string;
    /**
     * Also admit, as an owner of their own, any subject whose principal holds this capability with a
     * `{ "role": "owner" }` value: a native person with the owner role next to the `owner` subject's, with
     * their own name and attribution. Checked on every request, like `guestCapability`.
     */
    ownerCapability?: string;
    /** Public browser origin, independent of untrusted Host / forwarding headers. */
    origin: string;
}

/** A domain-qualified capability name, as Tailscale app capabilities use: `example.com/cap/pi-pocket`. */
const capabilityName = /^[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9._/-]+$/;

/** Whether a provider's verified grants for `capability` include a value with exactly this own `role`. */
function grantsRole(
    principal: AuthPrincipal,
    capability: string | undefined,
    role: "guest" | "owner",
): boolean {
    const capabilities: unknown = principal.capabilities;

    if (
        capability === undefined ||
        typeof capabilities !== "object" ||
        capabilities === null ||
        Array.isArray(capabilities) ||
        !Object.hasOwn(capabilities, capability)
    ) {
        return false;
    }

    const values: unknown = (capabilities as Record<string, unknown>)[capability];

    return (
        Array.isArray(values) &&
        values.some(
            (value) =>
                typeof value === "object" &&
                value !== null &&
                Object.hasOwn(value, "role") &&
                (value as { role?: unknown }).role === role,
        )
    );
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
    readonly #policy: ExternalAuthPolicy & { guests: readonly string[] };
    readonly #timeoutMs: number;
    readonly #people = new WeakMap<IncomingMessage, string>();

    constructor(provider: AuthProvider, policy: ExternalAuthPolicy, timeoutMs = 5000) {
        if (
            typeof provider?.id !== "string" ||
            provider.id.length === 0 ||
            typeof provider.authenticate !== "function" ||
            typeof policy.owner !== "string" ||
            policy.owner.length === 0 ||
            (policy.guests !== undefined &&
                (!Array.isArray(policy.guests) ||
                    !policy.guests.every(
                        (subject) => typeof subject === "string" && subject.length > 0,
                    ))) ||
            (policy.guestCapability !== undefined &&
                (typeof policy.guestCapability !== "string" ||
                    !capabilityName.test(policy.guestCapability))) ||
            (policy.ownerCapability !== undefined &&
                (typeof policy.ownerCapability !== "string" ||
                    !capabilityName.test(policy.ownerCapability))) ||
            new URL(policy.origin).origin !== policy.origin
        ) {
            throw new Error("Invalid external authentication configuration");
        }

        this.#provider = provider;
        this.#policy = { ...policy, guests: [...(policy.guests ?? [])] };
        this.#timeoutMs = timeoutMs;
    }

    /** Called before *any* dispatcher branch, even app files, capabilities, hooks and sign-in pages. */
    async admit(
        request: IncomingMessage,
        config: ConfigStore,
        opaqueCapability = false,
    ): Promise<void> {
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

        // The bootstrap owner is the exact subject. Another owner, a person of their own, holds the owner capability
        // on this request. A guest is listed or holds the guest capability. Losing a capability denies the next
        // request but keeps the native person and binding for when it returns.
        const subject = typeof principal?.subject === "string" ? principal.subject : "";
        const bootstrapOwner = subject.length > 0 && subject === this.#policy.owner;
        const additionalOwner =
            subject.length > 0 &&
            !bootstrapOwner &&
            grantsRole(principal!, this.#policy.ownerCapability, "owner");

        if (
            subject.length === 0 ||
            (!bootstrapOwner &&
                !additionalOwner &&
                !this.#policy.guests.includes(subject) &&
                !grantsRole(principal!, this.#policy.guestCapability, "guest"))
        ) {
            throw new HttpError(403, "External identity not admitted");
        }

        // X-Pocket alone is not an Origin check when an upstream authenticates every browser request.
        const origin = request.headers.origin;
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
        // The router grants this exception only to verified signed assets and capability-only
        // public routes. Their sandbox has an opaque origin; this never grants access to an API.
        const opaque = opaqueCapability && (origin === undefined || origin === "null");
        // A link followed from another site (a chat, mail or issue) opens a top-level document: it only reads, and a
        // frame, a subresource or any other method from another site is still refused below. Origin is checked too.
        const navigation =
            (request.method === "GET" || request.method === "HEAD") &&
            request.headers["sec-fetch-mode"] === "navigate" &&
            request.headers["sec-fetch-dest"] === "document";

        if (
            (origin !== undefined && origin !== this.#policy.origin && !opaque) ||
            (request.headers["sec-fetch-site"] === "cross-site" && !opaque && !navigation) ||
            (mutation && origin !== this.#policy.origin && !opaque)
        ) {
            throw new HttpError(403, "Use Pi Pocket's configured origin");
        }

        const user = config.externalUser(
            this.#provider.id,
            subject,
            bootstrapOwner || additionalOwner,
            principal!.name,
            additionalOwner,
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
