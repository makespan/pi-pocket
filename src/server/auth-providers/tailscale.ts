/** Tailscale Serve identity assertions, authenticated by an isolated admin gateway's injected secret. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";
import { readAuthFile, type AuthProvider } from "../auth-provider.ts";

/** Below Node's default 16 KiB for all headers, so the limit is the provider's and is reachable. */
const maxAppCapabilitiesLength = 8 * 1024;
/** Serve's RFC 2047 form, as Go's mime.QEncoding writes it: whole value, words split by one space. */
const qEncodedWords =
    /^=\?utf-8\?q\?(?:[!-<>@-~]|=[0-9A-F]{2})*\?=(?: =\?utf-8\?q\?(?:[!-<>@-~]|=[0-9A-F]{2})*\?=)*$/i;

/** Decode Serve's Q-encoded words to UTF-8 text, or undefined if any byte is not valid UTF-8. */
function decodeQWords(value: string): string | undefined {
    const bytes: number[] = [];

    for (const word of value.split(" ")) {
        const text = word.slice("=?utf-8?q?".length, -"?=".length);

        for (let index = 0; index < text.length; index++) {
            if (text[index] === "=") {
                bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
                index += 2;
            } else {
                bytes.push(text[index] === "_" ? 0x20 : text.charCodeAt(index));
            }
        }
    }

    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
        return undefined;
    }
}

/**
 * Serve's `Tailscale-App-Capabilities` (with `--accept-app-caps`): a JSON object of capability name → values.
 * Anything else, including a repeated header, grants nothing. Capabilities can only add access, so ignoring
 * them fails closed; they never decide who the person is.
 */
function appCapabilities(request: IncomingMessage): Record<string, unknown[]> | undefined {
    const values = request.headersDistinct["tailscale-app-capabilities"];

    if (values?.length !== 1 || values[0]!.length > maxAppCapabilitiesLength) {
        return undefined;
    }

    const value = values[0]!;
    let text: string | undefined;

    if (qEncodedWords.test(value)) {
        text = decodeQWords(value);
    } else if (/^[\t\x20-\x7e]*$/.test(value)) {
        // Serve encodes every value with a byte outside printable ASCII, so raw ones are not its assertion.
        text = value;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text ?? "");
    } catch {
        return undefined;
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every((each) => Array.isArray(each))
    ) {
        return undefined;
    }

    return parsed as Record<string, unknown[]>;
}

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

            const capabilities = appCapabilities(request);

            return capabilities === undefined
                ? { subject: login }
                : { subject: login, capabilities };
        },
    };
}
