# Tailscale external authentication

The bundled provider is `src/server/auth-providers/tailscale.ts`. It implements the [required startup provider API](external-auth.md), not an optional Pocket extension. The existing launcher's `--access tailscale` only makes an instance reachable; **it does not configure this authentication boundary**.

## Gateway boundary (required)

Use this topology on a shared Unix host:

```text
Tailnet browser → tailscaled Serve (TLS and verified user identity)
               → admin gateway's protected ingress
               → per-instance backend socket, with injected per-instance secret
```

**The gateway ingress must be unreachable by other Unix users.** One concrete arrangement is to run `tailscaled` and the gateway together in an administrator-controlled Linux network namespace: Serve forwards to gateway loopback **inside that namespace**, with no gateway port exposed on the host or namespace's non-loopback interfaces. Unprivileged host users must have neither namespace-entry capabilities nor access to an equivalent ingress socket. Only the authenticated Serve path may reach that listener. Alternatively, use a protected Unix-socket ingress if the administrator's identity-forwarding transport supports it. Ordinary host loopback is **not** an equivalent protection.

Configure Serve as the TLS identity verifier; do not expose the gateway directly or use Funnel. The gateway must accept identity headers only from that verified transport, not arbitrary browser headers. Check that the deployed Serve version strips/overwrites client-supplied `Tailscale-User-Login`; a user must not be able to supply another user's login through it. Tagged devices have no user login and must be rejected. Do not synthesize an owner login for missing/tagged users.

At the gateway, administrator-owned routing selects the instance, then:

- Overwrite `X-Pocket-Gateway-Secret` with that instance's secret. Never forward a caller-supplied value.
- Forward only the authoritative `Tailscale-User-Login` from Serve. It is the exact full login, not the user's display name. Do not let request parameters, cookies, role headers, paths or arbitrary hostnames choose a login or secret.
- Preserve the public browser Origin. Set trusted Host/forwarding headers for that public address. Do not rewrite hostile Origins into the allowed origin.
- Proxy **every** route through this boundary, including static/PWA files, SSE, polls, published artifacts, extension public pages and webhooks. Do not add anonymous exceptions or cache authenticated answers across users.
- Disable SSE buffering and allow long polling. Strip identity and gateway-secret headers before passing requests to any unrelated upstream. Do not log credentials or assertion headers, enable proxy debug logs, or return them in error pages.

For example, an nginx instance listener **inside the protected namespace** can use the following shape (substitute administrator-owned paths/addresses):

```nginx
server {
    listen 127.0.0.1:8080;
    server_name pocket.example.com;
    access_log off;

    location / {
        # Root-only include, generated with the SAME secret as gateway-secret below:
        # proxy_set_header X-Pocket-Gateway-Secret "<random-base64url-secret>";
        include /etc/pocket-gateway/alice-secret.conf;
        proxy_set_header Tailscale-User-Login $http_tailscale_user_login;
        proxy_set_header Tailscale-User-Name "";
        proxy_set_header Host pocket.example.com;
        proxy_set_header X-Forwarded-Host pocket.example.com;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_pass http://unix:/run/pi-pocket/alice/pocket.sock;
    }
}
```

Here `/run/pi-pocket/alice/pocket.sock` is the instance's Unix socket (`--socket`) in an administrator-made folder that only Alice can write and the gateway's group can read (see [the backend](#the-backend-must-not-be-a-shared-port)). A network namespace does not separate the file system, so the gateway inside it reaches the socket directly. Serve targets namespace-local `http://127.0.0.1:8080`. This is a proxy contract, not a namespace/Unix-account provisioning script. Do **not** copy the listener onto ordinary shared-host localhost. A shared proxy serving several instances needs a different injected secret per instance and fixed administrator-owned routing to each backend. Prefix/cookie/PWA routing is independent of this provider. Shared-prefix hosting is suitable only when every instance owner, guest and browser extension is mutually trusted across all instances: scripts on one path can act as a visitor on another. Otherwise require a distinct browser origin per instance; origin pinning does not isolate sibling paths.

### The backend must not be a shared port

Without the injected secret, forged Serve headers and Pocket tokens sent straight to the backend are denied. That does **not** make a TCP backend safe on a host with other Unix users: the gateway sends the secret to whatever listens on the backend address. While the instance restarts (Menu → Restart server, an update, a crash), its port is free; any other user can bind it, receive the gateway's next requests with the secret, and then use the secret against the real instance as the owner. Binding a specific address or loopback does not help.

So on a shared host, run each backend with `--socket` in a folder that the instance's user owns and no other user can write, with the gateway's group ([hosted instances](hosted-instances.md#why-a-socket-not-a-port) has the folder setup and Pi Pocket's startup checks), or give a TCP backend equivalent isolation: an address that no other user can bind, such as a network namespace of its own that they cannot enter. If local users can reach the **gateway ingress**, they can ask it to attach the real secret to a forged login. The secret does not fix an unprotected gateway, and the gateway's own port needs the same care against takeover. Root, the instance owner, the gateway, tailscaled and owner-UID code are trusted. Do not share secrets between mutually untrusted instances.

## Single origin with path prefixes

The [combined hosting guide](hosted-instances.md) shows one protected Tailscale endpoint and fixed per-user gateway routes (Caddy or nginx) to per-user sockets, each with its own gateway secret and an unchanged path prefix. This layout requires **every owner, guest and browser extension on every instance to be trusted by all the others**. A script on one instance can act with a visitor's privileges on another same-origin instance, including owner privileges. Per-instance secrets stop forged direct-backend requests; they do not isolate browser paths or make this a hostile multi-tenant deployment. Use distinct browser origins if that trust does not hold.

## Instance configuration

Generate at least 32 random bytes, base64url-encoded, into a private file. For example, as the instance owner in an owner-only directory:

```sh
umask 077
node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("base64url"))' > /home/alice/.pi-pocket/gateway-secret
chmod 600 /home/alice/.pi-pocket/gateway-secret
```

The admin gateway needs the same value in its root-only include/config, distributed securely without putting it on a command line or in browser-visible configuration. The provider secret file must be an absolute path to a restricted regular file owned by root or the instance owner; symlinks and group/other permissions are refused. Parent directories must be protected too. The provider reads it once at startup, so rotate the gateway and instance together, restarting the instance.

Write a restricted `0600` JSON file, for example `/home/alice/.pi-pocket/external-auth.json`:

```json
{
    "module": "/opt/pi-pocket/src/server/auth-providers/tailscale.ts",
    "options": {
        "secretFile": "/home/alice/.pi-pocket/gateway-secret"
    },
    "owner": "alice@example.com",
    "guests": ["trusted-friend@example.com"],
    "origin": "https://pocket.example.com"
}
```

Use the installed checkout's actual absolute module path. The namespace is `tailscale`, and the subject is the full `Tailscale-User-Login` string, compared case-sensitively with no normalization. Display names, client IPs, cookie/bearer tokens and request-supplied roles have no authority. The secret is checked with a constant-time comparison of fixed-length SHA-256 digests; missing/wrong assertions, missing login, tagged-node logins and merged duplicate assertions are denied. No native guest bearer tokens are minted or stored at the gateway.

Start with the external configuration in the service environment:

```sh
PI_POCKET_AUTH_CONFIG=/home/alice/.pi-pocket/external-auth.json \
    node bin/pi-pocket.js --socket /run/pi-pocket/alice/pocket.sock --data /home/alice/.pi-pocket
```

Pi Pocket refuses to start if the socket's folder is a symlink, belongs to a user other than the instance's or root, or is writable by its group or others. The socket does not secure gateway ingress; the protected topology above does. Open the **public gateway address**, not the backend. There is no bootstrap QR/invite: the exact owner identity gets native owner access immediately. Other identities are denied unless explicitly listed. **Every newly admitted guest can steer Pi, execute commands as Alice's Unix user, and initially see all sessions.** Only list people trusted with that access. Viewer/session/budget edits then persist across browsers and restarts. Native removal is permanent until explicit offline readmission; restarting does not recreate a deleted person.

Keep `PI_POCKET_AUTH_CONFIG` required in the service unit/environment after updates and restarts. Before admitting users, test from another unprivileged Unix account: the backend socket must refuse its connections, and no backend TCP port may be listening; direct requests with forged Serve headers must fail; the gateway ingress must be unreachable; an authenticated unlisted tailnet user and a tagged device must fail. Verify owner and allowlisted guest roles, a persisted viewer downgrade and removal after restart. No live Tailscale credentials or deployment are required by the repository's automated tests; they drive real HTTP with fabricated authenticated/forged gateway assertions.
