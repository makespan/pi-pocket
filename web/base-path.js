// App-owned addresses and browser state. The server sets this value before any other script runs.
export const basePath = globalThis.POCKET_BASE_PATH ?? "";

/** Add the mount point to an app-owned root-relative path (not to an external URL or an already public URL). */
export function appUrl(path) {
    if (!path.startsWith("/") || path.startsWith("//")) {
        throw new Error("An app path must start with one slash");
    }

    return basePath + path;
}

/** The app route of a public pathname, or null outside this instance. */
export function appRoute(pathname) {
    return pathname.startsWith(basePath + "/") ? pathname.slice(basePath.length) : null;
}

/**
 * The icon colors cookie's name (`app-icon.js`): `pocket_icon` at the root, and one of this mount's own under a base path,
 * so that a root instance's cookie (path `/`) is never read by a mounted one. `src/base-path.ts` names it the same way.
 */
export const iconCookieName = (base) =>
    base === "" ? "pocket_icon" : `pocket_icon${base.replaceAll("/", "~")}`;

/** Root installations retain their existing keys. Prefixed instances never read or migrate root state. */
export const storageKey = (key) => (basePath ? `pocket@${basePath}:` : "") + key;
export const shareCache = storageKey("pocket-share");

/** Explicit storage adapters, not patches to the browser's shared globals. Enumeration exposes only this mount. */
function scopedStorage(name) {
    const keys = () => {
        const storage = globalThis[name];
        const prefix = storageKey("");

        return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
            (key) => (basePath ? key.startsWith(prefix) : !key.startsWith("pocket@/")),
        );
    };

    return Object.freeze({
        getItem: (key) => globalThis[name].getItem(storageKey(key)),
        setItem: (key, value) => globalThis[name].setItem(storageKey(key), value),
        removeItem: (key) => globalThis[name].removeItem(storageKey(key)),
        key: (index) => keys()[index]?.slice(storageKey("").length) ?? null,
        get length() {
            return keys().length;
        },
    });
}

export const localStore = scopedStorage("localStorage");
export const sessionStore = scopedStorage("sessionStorage");

/** Decode a StorageEvent key for this instance; undefined means another mount. Null is the browser's clear event. */
export function storageEventKey(key) {
    if (key === null) {
        return null;
    }

    return basePath
        ? key.startsWith(storageKey(""))
            ? key.slice(storageKey("").length)
            : undefined
        : key.startsWith("pocket@/")
          ? undefined
          : key;
}
