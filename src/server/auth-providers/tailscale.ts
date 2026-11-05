/** Tailscale Serve identity assertions, authenticated by an isolated admin gateway's injected secret. */
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { readAuthFile, type AuthProvider } from "../auth-provider.ts";

/** The gateway and instance share a different random secret per instance, never a native guest bearer token. */
export interface TailscaleAuthOptions {
    secretFile: string;
}

export default function tailscale(options: unknown): AuthProvider {
    if (
        typeof options !== "object" ||
        options === null ||
        !("secretFile" in options) ||
        typeof options.secretFile !== "string" ||
        !isAbsolute(options.secretFile)
    ) {
        throw new Error("Tailscale authentication requires an absolute secretFile path");
    }

    const secret = readAuthFile(options.secretFile).trim();

    if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) {
        throw new Error(
            "Tailscale gateway secret must be at least 32 random bytes, encoded base64url",
        );
    }

    const digest = (value: string) => createHash("sha256").update(value).digest();
    const expected = digest(secret);

    return {
        id: "tailscale",
        async authenticate(request) {
            const assertion = request.headers["x-pocket-gateway-secret"];
            const login = request.headers["tailscale-user-login"];

            // Hash first so timingSafeEqual always compares fixed-length values. No socket/loopback trust.
            if (typeof assertion !== "string" || !timingSafeEqual(digest(assertion), expected)) {
                return undefined;
            }

            // Full login only: tagged nodes have no user login. Never fall back to name, IP or an owner header.
            // Reject merged duplicate headers too, rather than choosing one assertion from a list.
            if (typeof login !== "string" || !/^[^\s,@:]+@[^\s,@:]+$/.test(login)) {
                return undefined;
            }

            return { subject: login };
        },
    };
}
