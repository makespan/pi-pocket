# Several hosted instances on one tailnet address

This fork combines [base-path routing](base-path.md) with [external authentication](external-auth.md). It keeps Pi Pocket's UI and Pi Durable, and keeps each instance under a different Unix user. It is **not** a multi-tenant server or a sandbox for mutually untrusted guests. **Use this shared origin only if every owner, guest and browser extension on every instance is trusted by all the others.** A script on one instance can act with a visitor's privileges on another, including owner privileges; separate Unix accounts and per-instance proxy secrets cannot prevent that browser-level access.

```text
https://pocket.<tailnet>.ts.net/alice.name/
    → Tailscale Serve → protected routing gateway → Alice's instance
https://pocket.<tailnet>.ts.net/bob.name/
    → the same gateway                         → Bob's instance
```

One `tailscaled` HTTPS endpoint and one routing gateway serve all instances. A verified person is the owner on their instance and a native guest on another only when that instance explicitly allowlists them. Guest admission grants steering and initially all-session access; agents execute commands as that instance's Unix user. People controls still manage viewer downgrades, session grants, budgets and removal.

## Per-instance configuration

Run each instance as its actual non-root Unix account, with that account's HOME, working directory, private data directory and provider credentials. Do not run them together as root or use one shared HOME. Existing services should arrange storage-unlock dependencies, supervision and restart behavior for the host.

For Alice, write an owner-only `0600` configuration file and a separate per-instance gateway secret as described in [Tailscale authentication](tailscale-auth.md):

```json
{
    "module": "/opt/pi-pocket/src/server/auth-providers/tailscale.ts",
    "options": {
        "secretFile": "/home/alice.name/.pi-pocket/gateway-secret"
    },
    "owner": "alice@example.com",
    "guests": ["bob@example.com"],
    "origin": "https://pocket.<tailnet>.ts.net"
}
```

The origin has **no path**, while the mount is `/alice.name`. Use actual full tailnet login names and the real checkout path. A service for Alice starts the equivalent of:

```sh
PI_POCKET_AUTH_CONFIG=/home/alice.name/.pi-pocket/external-auth.json \
    node /opt/pi-pocket/bin/pi-pocket.js --access local --port 18787 \
    --base-path /alice.name --data /home/alice.name/.pi-pocket \
    --cwd /home/alice.name
```

Bob uses his own account, data/config/secret, owner login, port (for example `18788`) and `/bob.name` mount. The guest list is explicit, not every tailnet member or anyone sharing a display name. A removed person stays revoked across browsers and restarts; do not delete external bindings to clean up configuration.

## Protect the gateway ingress first

Serve strips client-supplied identity headers and supplies the authenticated human's login. Pocket's provider also authenticates the gateway with a distinct secret for each instance. **Both boundaries matter:** an unprivileged local process must not reach the gateway and ask it to add a valid secret to a forged login.

A namespace-contained gateway is described in [Tailscale authentication](tailscale-auth.md). Another arrangement, when the host's `tailscaled` runs as UID 0, is a dedicated loopback gateway port protected by an administrator-owned UID firewall. For example, these rules protect port `18080` for IPv4 and IPv6:

```nft
 table inet pocket_gateway {
    chain input {
        type filter hook input priority -10; policy accept;
        iifname != "lo" tcp dport 18080 reject with tcp reset
    }
    chain output {
        type filter hook output priority -10; policy accept;
        oifname "lo" tcp dport 18080 meta skuid != 0 reject with tcp reset
    }
 }
```

This is a deployment example, not an automatically installed firewall. Validate and integrate it with the host's existing rules; load the protection **before** starting the listener and require it in gateway service dependencies. Keep it persistent across restarts. Confirm the actual tailscaled UID before relying on it. Root and its processes are trusted. An unprivileged account must not have capabilities or networking/proxy paths that bypass these rules. Never open this gateway port to the tailnet or public network, and never enable Funnel for it.

## Route without stripping the prefix

An nginx gateway inside that protected boundary can use fixed per-user locations. Replace the example DNS name and backend ports. The root-owned secret include must contain `proxy_set_header X-Pocket-Gateway-Secret "<that instance's random secret>";` and must never be readable by other Unix users.

```nginx
server {
    listen 127.0.0.1:18080;
    server_name pocket.<tailnet>.ts.net;
    access_log off;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host pocket.<tailnet>.ts.net;
    proxy_set_header X-Forwarded-Host pocket.<tailnet>.ts.net;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Tailscale-User-Login $http_tailscale_user_login;
    proxy_set_header Tailscale-User-Name "";
    proxy_buffering off;
    proxy_read_timeout 1h;

    location = /alice.name { return 308 /alice.name/; }
    location /alice.name/ {
        # Repeat inherited proxy headers here: nginx inherits proxy_set_header
        # only when no proxy_set_header appears at this configuration level.
        include /etc/pocket-gateway/common-headers.conf;
        include /etc/pocket-gateway/alice-secret.conf;
        proxy_pass http://127.0.0.1:18787;
    }

    location = /bob.name { return 308 /bob.name/; }
    location /bob.name/ {
        include /etc/pocket-gateway/common-headers.conf;
        include /etc/pocket-gateway/bob-secret.conf;
        proxy_pass http://127.0.0.1:18788;
    }

    location / { return 404; }
}
```

Put the six `proxy_set_header` directives shown at server level into the root-owned `common-headers.conf` as well (Connection, Host, both forwarding headers and both identity headers). Each location sets its own secret, so nginx does not inherit the server's header directives there. Do not omit the common include. There is **no trailing slash** after either `proxy_pass` target: the backend must receive `/alice.name/...`, not `/...`. Never trust a forwarded-prefix header or route identity/secret selection from arbitrary request parameters. Preserve Origin as received; do not make hostile cross-origin requests look same-origin. Do not add shared response caches or authentication exceptions for static files, SSE, polling, artifacts or webhooks.

Configure the existing Tailscale HTTPS endpoint to forward to `http://127.0.0.1:18080`. Do not reset or replace unrelated Serve routes. Opening the public prefixed address signs in through the external identity; no owner-token links, QR or invite code is needed. Tagged clients without a human login are denied.

## Validate before rollout

- From a different unprivileged Unix account, the gateway port is unreachable, and direct backend requests with forged identity headers but no valid gateway secret are denied.
- Forged identity headers sent through Serve do not override the real human identity. Missing, tagged and unlisted identities are denied.
- The same human is owner on their instance and guest/viewer on another, never the other instance's owner. Native permissions, viewer downgrade, budget/session changes and removal persist across restart.
- Both prefixes load assets, SSE/poll, deep links, artifacts, themes and extensions. PWA install/share/notification URLs and browser state stay associated with the correct instance.
- Secrets are absent from browser responses and access/error/debug logs. Every instance runs under its intended UID/HOME with a different secret.

The automated tests exercise synthetic providers/gateway assertions and real browser startup, not a live tailnet or Linux firewall. Those deployment checks remain required.

**Paths are not browser security boundaries.** Cookies, caches and application storage are scoped to avoid accidental collisions, but same-origin scripts can access other paths and origin storage. Use only trusted browser extensions and collaborators here; use distinct origins and stronger execution isolation for hostile tenants. Guests that can steer already have the instance owner's tool/file rights.

Keep the checkout pinned to reviewed fork commits. Do not install public npm `pi-pocket` releases over it or automatically replace it with upstream code until upstream supports the same authentication and routing contract. The upstream proposals are [#275](https://github.com/TannerMidd/pi-pocket/issues/275) and [#276](https://github.com/TannerMidd/pi-pocket/issues/276).
