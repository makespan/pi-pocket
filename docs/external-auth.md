# External authentication

External authentication replaces device pairing for an instance. It does **not** create Unix accounts, isolate tenants, or change native authorization. Without `PI_POCKET_AUTH_CONFIG`, pairing works as before.

The bundled [Tailscale provider and gateway contract](tailscale-auth.md) is a tested implementation of this interface.

## Required startup configuration

Set `PI_POCKET_AUTH_CONFIG` to an absolute JSON file path before starting Pi Pocket. The file must be a regular file owned by the instance's Unix user or root, with no group/other permissions (normally `0600`). Keep its parent directories and provider code writable only by trusted administrators/the instance owner. Symlinks for this file are refused.

```json
{
    "module": "/absolute/path/to/provider.mjs",
    "options": {},
    "owner": "owner@example.com",
    "guests": ["trusted-friend@example.com"],
    "guestCapability": "example.com/cap/pi-pocket",
    "origin": "https://pocket.example.com"
}
```

`module` is a filesystem path, absolute or relative to the configuration file, not an import URL. `options` is passed to its default export. `owner` and `guests` are **exact, case-sensitive full subjects**, not display names. `guests` and `guestCapability` are optional; without either, only the owner is admitted. `guestCapability` is a capability name of the form `domain/path` (lowercase domain, for example `example.com/cap/pi-pocket`); any other value stops startup. `origin` is the browser's public origin (scheme, host, optional port; no path or trailing slash), independent of Host and forwarded headers. Changes require a server restart. Protect the service environment too: unsetting the variable deliberately returns to pairing mode.

The required module initializes **before listening**, with a five-second deadline. Its factory signal covers initialization only and is aborted when initialization ends; it is not a server-lifetime signal. Missing/invalid configuration, failed imports, a missing factory/provider, exceptions, and timeouts stop startup. This is not a module in `extensions/`, cannot be hot-reloaded or turned off in the Extensions sheet, and is not `/api/x/` middleware. It runs as the Unix owner, **not in a sandbox**. Like any owner-UID code, it could log secrets or block the event loop; the deadline bounds asynchronous waits, not hostile code.

## Provider API (experimental)

The module default-exports `(options: unknown, signal: AbortSignal) => AuthProvider | Promise<AuthProvider>`. The types are defined in `src/server/auth-provider.ts`:

```ts
interface AuthProvider {
    id: string;
    authenticate(
        request: IncomingMessage,
        signal: AbortSignal,
    ): Promise<
        { subject: string; name?: string; capabilities?: Record<string, unknown[]> } | undefined
    >;
}
```

`id` is a stable provider namespace, not a browser/client-supplied value. `authenticate` must verify the transport and identity before returning a full stable subject. Return `undefined` for missing, tagged, invalid or otherwise unverifiable identities. A display name is optional and used only on first guest creation. `capabilities` are the subject's **verified** grants, capability name → list of values, for this request only (the Tailscale provider passes Serve's app capabilities); omit them when there are none or they cannot be verified. Never return a role, native user ID or session grants; core alone decides them. Respect cancellation and do not consume the request body. Do not put assertions, credentials, headers or exception details in logs.

Core calls the provider before **every dispatched HTTP request**: app shell and files, API, SSE, each poll, artifacts and their assets, published capabilities, extension public links, webhooks, and pairing routes. A missing/unallowed principal is denied; provider exceptions/timeouts return a generic `503` without error details. A cookie or bearer token never bypasses this check. Already-open SSE connections are checked on admission, not on every event; restart closes them when startup policy changes. Native user removal closes connected tabs immediately, as before.

Core also checks the pinned origin. A supplied Origin must match exactly; mutations require it. Cross-site Fetch Metadata is denied even with `X-Pocket: 1`, with one exception: **top-level navigations are allowed**, so a link to `/s/1` followed from chat, mail or an issue opens the app. That is only `GET` or `HEAD` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, and no Origin or exactly the configured one; the external identity is still required. Cross-site frames, subresources, fetches and form posts stay denied. The narrow sandbox exceptions are reads of cryptographically verified signed artifact assets, reads of published bundle assets, and urlencoded posts to public-link capability pages: these accept the sandbox's opaque (`null` or absent) Origin while still requiring external identity and the native capability checks. Unsigned artifact paths, invalid signatures and API requests get no such exception. Normal API mutations still require `X-Pocket: 1`. Nonbrowser clients/webhook senders must authenticate externally and supply the configured Origin for mutations; existing hook/capability secrets alone are insufficient. No general cross-origin CORS access is added.

## Native people and revocation

The configured owner subject binds to the existing native owner on first use: no QR/bootstrap invite is needed. The owner is that exact subject alone; it needs no capability. Another subject is admitted as a native guest only when it is in `guests`, or when `guestCapability` is set and the provider's principal holds that capability with at least one value that is an object with `"role": "guest"` (for example `[{"role": "guest"}]`). Other values, such as `{"role": "viewer"}`, an empty list or `{}`, admit nobody: Pocket does not take roles from the identity system, and viewer downgrades are made in People. **Adding a guest, or granting the capability to a group, opts into native steering access, including executing commands as the instance's Unix owner, and initially every session.** Do not add arbitrary tailnet members or untrusted shared-host users, and grant the capability only to a group trusted with that access. Native viewer/session/budget controls remain app-level restrictions, not a Unix sandbox or a defense against someone already allowed to run owner-UID commands.

Core saves a provider/subject → native user ID binding in `config.json`, in the same atomic save as guest creation. All browsers share that person, across restarts. Reconnecting does not overwrite names, roles, session scope or budgets. Downgrading a guest to viewer persists. No recoverable bearer token is created for external guests or stored at a gateway.

Removing a person leaves their binding as a **permanent tombstone**: first visit cannot recreate them, with or without the capability. Removing an entry from the startup `guests` list denies future requests after restart; re-adding an entry restores only its existing binding, not a deleted person. The capability is checked on **every request**, without a restart: once the identity system stops granting it (for example, the person leaves the granted group), their next request is denied with `403`, but their native person, binding and settings stay. If it is granted again, the same person returns, with the role, sessions and budget they had, unless they were removed. An SSE stream that is already open was checked when it opened and keeps delivering events until it ends; every other request, and its reconnection, is denied. To cut a person off at once, remove them in People. Keep bindings when migrating/backing up configuration. A bound guest cannot become owner by changing the owner subject; an already-bootstrapped provider cannot automatically bind a second owner subject. Deliberate identity migration/readmission requires stopping the server and explicit offline administration of the affected binding and person; do not delete bindings as routine cleanup.

Externally authenticated instances disable `/login`, `/join`, invites, owner-token login and Pocket logout. Startup/launcher output has no owner-token link or sign-in QR. The app still offers People/access controls but not pairing; sign out/revoke through the external identity system. Existing owner-token/config fields remain backward-readable but are not accepted in external mode. Do not accidentally start the same data directory without its required auth environment.

## Trust boundary

Use a unique browser origin per instance unless **every instance owner, guest and browser extension is mutually trusted across every instance**. A script on one same-origin instance can act with a visiting person's privileges on another, including their owner privileges. Origin pinning and separate Unix accounts cannot prevent that. The shared-prefix topology is only for that fully trusted group, not private tenants.

A provider must not trust identity headers merely because a request came from loopback: other Unix users can connect to localhost. They can also bind a backend's free TCP port while it restarts and receive the gateway's assertions, so on a shared host listen on an administrator-protected Unix socket (`--socket`, [hosted instances](hosted-instances.md#why-a-socket-not-a-port)) or give the backend equivalent isolation. Authenticate gateway assertions and protect the gateway's own ingress from forged identity headers. A shared reverse proxy must select the instance from administrator-owned routing, overwrite assertion/secret headers, preserve the public origin, authenticate **all** routes, disable shared response caching and buffer neither SSE nor long polling. Native capabilities that were anonymous in pairing mode are intentionally no longer anonymous here. Server/OS provisioning and reverse-proxy deployment are administrator responsibilities, not automatic features of this interface.
