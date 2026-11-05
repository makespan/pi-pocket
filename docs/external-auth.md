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
    "origin": "https://pocket.example.com"
}
```

`module` is a filesystem path, absolute or relative to the configuration file, not an import URL. `options` is passed to its default export. `owner` and `guests` are **exact, case-sensitive full subjects**, not display names. `origin` is the browser's public origin (scheme, host, optional port; no path or trailing slash), independent of Host and forwarded headers. Changes require a server restart. Protect the service environment too: unsetting the variable deliberately returns to pairing mode.

The required module initializes **before listening**, with a five-second deadline. Missing/invalid configuration, failed imports, a missing factory/provider, exceptions, and timeouts stop startup. This is not a module in `extensions/`, cannot be hot-reloaded or turned off in the Extensions sheet, and is not `/api/x/` middleware. It runs as the Unix owner, **not in a sandbox**. Like any owner-UID code, it could log secrets or block the event loop; the deadline bounds asynchronous waits, not hostile code.

## Provider API (experimental)

The module default-exports `(options: unknown, signal: AbortSignal) => AuthProvider | Promise<AuthProvider>`. The types are defined in `src/server/auth-provider.ts`:

```ts
interface AuthProvider {
    id: string;
    authenticate(
        request: IncomingMessage,
        signal: AbortSignal,
    ): Promise<{ subject: string; name?: string } | undefined>;
}
```

`id` is a stable provider namespace, not a browser/client-supplied value. `authenticate` must verify the transport and identity before returning a full stable subject. Return `undefined` for missing, tagged, invalid or otherwise unverifiable identities. A display name is optional and used only on first guest creation. Never return a role, native user ID or session grants; core alone decides them. Respect cancellation and do not consume the request body. Do not put assertions, credentials, headers or exception details in logs.

Core calls the provider before **every dispatched HTTP request**: app shell and files, API, SSE, each poll, artifacts and their assets, published capabilities, extension public links, webhooks, and pairing routes. A missing/unallowed principal is denied; provider exceptions/timeouts return a generic `503` without error details. A cookie or bearer token never bypasses this check. Already-open SSE connections are checked on admission, not on every event; restart closes them when startup policy changes. Native user removal closes connected tabs immediately, as before.

Core also checks the pinned origin. A supplied Origin must match exactly; mutations require it. Cross-site Fetch Metadata is denied even with `X-Pocket: 1`. Normal API mutations still require `X-Pocket: 1`. Nonbrowser clients/webhook senders must authenticate externally and supply the configured Origin for mutations; existing hook/capability secrets alone are insufficient. No cross-origin CORS access is added.

## Native people and revocation

The configured owner subject binds to the existing native owner on first use: no QR/bootstrap invite is needed. Only explicit guest allowlist entries are admitted automatically. **Adding a guest opts into native steering access, including executing commands as the instance's Unix owner, and initially every session.** Do not add arbitrary tailnet members or untrusted shared-host users. Native viewer/session/budget controls remain app-level restrictions, not a Unix sandbox or a defense against someone already allowed to run owner-UID commands.

Core saves a provider/subject → native user ID binding in `config.json`, in the same atomic save as guest creation. All browsers share that person, across restarts. Reconnecting does not overwrite names, roles, session scope or budgets. Downgrading a guest to viewer persists. No recoverable bearer token is created for external guests or stored at a gateway.

Removing a person leaves their binding as a **permanent tombstone**: first visit cannot recreate them. Removing an entry from the startup allowlist denies future requests after restart; re-adding an entry restores only its existing binding, not a deleted person. Keep bindings when migrating/backing up configuration. A bound guest cannot become owner by changing the owner subject; an already-bootstrapped provider cannot automatically bind a second owner subject. Deliberate identity migration/readmission requires stopping the server and explicit offline administration of the affected binding and person; do not delete bindings as routine cleanup.

Externally authenticated instances disable `/login`, `/join`, invites, owner-token login and Pocket logout. Startup/launcher output has no owner-token link or sign-in QR. The app still offers People/access controls but not pairing; sign out/revoke through the external identity system. Existing owner-token/config fields remain backward-readable but are not accepted in external mode. Do not accidentally start the same data directory without its required auth environment.

## Trust boundary

A provider must not trust identity headers merely because a request came from loopback: other Unix users can connect to localhost. Authenticate gateway assertions and protect the gateway's own ingress from forged identity headers. A shared reverse proxy must select the instance from administrator-owned routing, overwrite assertion/secret headers, preserve the public origin, authenticate **all** routes, disable shared response caching and buffer neither SSE nor long polling. Native capabilities that were anonymous in pairing mode are intentionally no longer anonymous here. Server/OS provisioning and reverse-proxy deployment are administrator responsibilities, not automatic features of this interface.
