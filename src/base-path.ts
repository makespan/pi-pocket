/** The public mount point. Validate before URL parsing, which would otherwise erase dot segments. */
export function parseBasePath(value = ""): string {
    if (value === "" || value === "/") {
        return "";
    }

    if (
        !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) ||
        value.split("/").some((segment) => segment === "." || segment === "..")
    ) {
        throw new Error(
            "--base-path must be / or /safe/segments (letters, digits, ., _ and -, no dot segments or trailing slash)",
        );
    }

    return value;
}

/** Add the mount point to an app-owned root-relative path, exactly once at its generation site. */
export function appPath(basePath: string, path: string): string {
    if (!path.startsWith("/") || path.startsWith("//")) {
        throw new Error("An app path must start with one slash");
    }

    return basePath + path;
}

/** Strip one literal prefix, rejecting path spellings a proxy or URL parser might interpret differently. */
export function requestPath(target: string, basePath: string): string | undefined {
    const path = target.split("?", 1)[0]!;

    if (!path.startsWith("/") || /[\\#\u0000-\u0020\u007f]/.test(path)) {
        return undefined;
    }

    try {
        for (const segment of path.split("/")) {
            const decoded = decodeURIComponent(segment);

            if (
                decoded === "." ||
                decoded === ".." ||
                /[\\/\u0000-\u001f\u007f]/.test(decoded) ||
                /%(?:25|2e|2f|5c)/i.test(decoded)
            ) {
                return undefined;
            }
        }
    } catch {
        return undefined;
    }

    if (path.includes("//") || (basePath !== "" && !path.startsWith(basePath + "/"))) {
        return undefined;
    }

    return path.slice(basePath.length);
}

/** A login destination must remain inside this mount, including after URL normalization. */
export function loginNext(next: string | null, basePath: string): string {
    return next !== null &&
        !/[\u0000-\u001f\u007f]/.test(next) &&
        requestPath(next.split("#", 1)[0]!, basePath) !== undefined
        ? next
        : appPath(basePath, "/");
}
