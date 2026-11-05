# Running behind a path-prefix proxy

One Pocket can run as each Unix user, with a separate port and data folder, behind one reverse proxy. For example, run this as `julian.rath`:

```sh
pi-pocket --host 127.0.0.1 --port 8787 --base-path /julian.rath
# Or set PI_POCKET_BASE_PATH=/julian.rath
```

The flag overrides the environment. The default is the existing root installation. An empty value or `/` means root; other values must start with `/`, have no trailing slash, and contain only letters, digits, `.`, `_`, and `-` in nonempty segments. Whole `.` and `..` segments are forbidden. `/team/julian.rath` is also valid. This is a startup option, not stored configuration.

Give each instance its own port, Unix account, and data directory. Use disjoint public mounts, such as `/julian.rath/` and `/jakob.auer/`, not overlapping mounts. This guide describes the proxy contract, not host provisioning. For the combined owner/guest login setup and its fully trusted-group restriction, see [several hosted instances](hosted-instances.md) and [Tailscale authentication](tailscale-auth.md#single-origin-with-path-prefixes).

## Proxy contract

**Preserve the prefix.** Pocket receives `/julian.rath/api/me`, not `/api/me`. It validates the raw path, strips exactly one literal `/julian.rath`, and dispatches the remainder. Requests outside that mount, repeated slashes, dot/traversal segments, encoded slashes or backslashes, and ambiguous double-encoded traversal/separators are refused. Query values (such as filesystem paths) are not path prefixes and are not rewritten.

An illustrative nginx location is:

```nginx
location = /julian.rath {
    return 308 /julian.rath/$is_args$args;
}
location /julian.rath/ {
    # No trailing slash on proxy_pass: retain the original request URI.
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Use the equivalent prefix-preserving behavior with another proxy. Do not decode or normalize ambiguous request paths into acceptable ones before forwarding them. Do not strip or add a prefix using `X-Forwarded-Prefix`: Pocket uses only its startup setting. Redirect the bare mount to its trailing-slash URL at the proxy; Pocket itself requires that slash. Forward SSE responses without buffering; live updates use SSE or long polling, not WebSockets. Terminate HTTPS at the proxy for push and PWA sharing. Restrict direct backend access and replace client-supplied forwarding headers with trusted proxy values. Links use the public host and scheme supplied by that proxy.

All app assets, API URLs, login/invite destinations, themes, extension modules, artifacts, public pages, push links, and PWA URLs include the mount. External addresses and webhook/message payload text are not rewritten. A login `next` must be a path inside this same mount. Cookies use a mount-specific name and `Path=/julian.rath/`; root keeps `pocket_auth` and `Path=/`.

## Browser state and moving an instance

Each mount has its own local/session storage namespace, share cache, service worker scope, manifest identity and installed-app scope. Root retains the existing keys and cache name. A prefixed instance does not migrate root browser state. Changing the base path changes browser identity: sign in again, reinstall the PWA as needed, and remove obsolete registrations/installations through the browser. Existing public links must use the new prefix. Do not run a legacy root-scoped worker as a sibling instance; retire that root installation/registration before moving to per-user mounts.

**Paths are not hostile-tenant security boundaries.** Sibling instances still share a browser origin. Same-origin script, service workers, and code running as an instance's Unix user are not isolated by cookie paths or storage key conventions. A malicious extension or compromised sibling can reach other same-origin paths and browser storage. Use separate origins when browser security isolation is required. These namespaces prevent accidental state collisions; they do not provide tenant isolation or replace authentication or OS permissions.

## URL helpers for extension authors

Browser modules can import the no-build helper module through the app's import map:

```js
import { basePath, appUrl, localStore, sessionStore, storageKey } from "#pocket/base-path";

const download = appUrl(`/api/c/${conversation}/export`);
localStore.setItem("my-extension.choice", "compact");
```

- `basePath` is the immutable server-provided mount, available before any app script executes (`""` for root).
- `appUrl(path)` adds the mount to an **app-owned root-relative** path. Do not pass external URLs or already prefixed URLs. It adds the prefix once at the URL's generation site.
- `appRoute(publicPathname)` removes this instance's prefix, or returns `null` outside it.
- `localStore` and `sessionStore` expose scoped `getItem`, `setItem`, `removeItem`, `key`, and `length`. `storageKey(key)` returns the corresponding native storage key; `storageEventKey(key)` decodes a native storage-event key for this mount (`undefined` for another mount).

Keep using `pocket.api` for a module's own routes, `pocket.asset` for its browser files, and the URL/path returned by public-link APIs. Those already include the prefix. Core's built-in Design module also has import-map aliases `#pocket/store` and `#pocket/artifact-bridge` for its existing internal dependencies; these are not extension APIs.

On the server, core uses `PocketApp.basePath` and `app.url(path)` with the same generation-site rule. `src/base-path.ts` owns validation, raw-path stripping and login destination checks. Do not add response-text rewriting or global fetch patches.
