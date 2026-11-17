# Several hosted instances on one tailnet address

This fork combines [base-path routing](base-path.md) with [external authentication](external-auth.md). It keeps Pi Pocket's UI and Pi Durable, and keeps each instance under a different Unix user. It is **not** a multi-tenant server or a sandbox for mutually untrusted guests. **Use this shared origin only if every owner, guest and browser extension on every instance is trusted by all the others.** A script on one instance can act with a visitor's privileges on another, including owner privileges; separate Unix accounts and per-instance proxy secrets cannot prevent that browser-level access.

```text
https://<host>.<tailnet>.ts.net/alice.name/
    → Tailscale Serve (node, :443) → /run/caddy-front/pocket.sock → Caddy → /run/pi-pocket/alice.name/pocket.sock → Alice
https://<host>.<tailnet>.ts.net/bob.name/
    → the same Serve and Caddy                                          → /run/pi-pocket/bob.name/pocket.sock   → Bob
```

One `tailscaled` HTTPS endpoint (the node's own name) and one routing gateway serve all instances. Each instance listens on its own Unix socket, not a TCP port. A verified person is the owner on their instance (by exact login) and a native guest on another only while the tailnet grants them that instance's guest [app capability](tailscale-auth.md#guests-by-app-capability), or when that instance lists them explicitly. Guest admission grants steering and initially all-session access; agents execute commands as that instance's Unix user. People controls still manage viewer downgrades, session grants, budgets and removal.

## Per-instance configuration

Run each instance as its actual non-root Unix account, with that account's HOME, working directory, private data directory and provider credentials. Do not run them together as root or use one shared HOME. Existing services should arrange storage-unlock dependencies, supervision and restart behavior for the host.

### Why a socket, not a port

A TCP backend on a shared host is **not safe**, even on loopback and even with the gateway secret. While an instance restarts (Menu → Restart server, an update, a crash), its port is free, and any other Unix user can bind it. The gateway then sends that user's listener the next requests, **with the instance's injected secret**, and the listener can replay the secret to act as the owner once the real instance is back. Ports have no owner. A Unix socket in a folder that only the instance user can write cannot be taken this way: nobody else can create an entry at its path, before or after a restart. If an instance listened on a TCP port on a shared host before, rotate its gateway secret when you move it to a socket.

The administrator makes one folder per instance, owned by the instance's user, with the gateway's group and mode `2750` (the setgid bit gives the socket that group). For example with systemd-tmpfiles, in `/etc/tmpfiles.d/pi-pocket.conf`:

```text
d /run/pi-pocket            0755 root       root  -
d /run/pi-pocket/alice.name 2750 alice.name caddy -
d /run/pi-pocket/bob.name   2750 bob.name   caddy -
```

Use the gateway's actual group (`caddy` here, or nginx's). `--socket PATH` (or `PI_POCKET_SOCKET`) must be an absolute path. Before listening, Pi Pocket refuses to start (exit code 78) unless the socket's folder is a real folder, not a symlink or a path through one, owned by the instance's user or root, and not writable by its group or others. It replaces a stale socket that no server answers on, and refuses anything else at the path (it never follows a symlink or deletes another kind of file). After listening it sets the socket to `0660`, so the folder's group (the gateway) can connect, and it removes the socket when it stops. `--socket` replaces `--host`, `--port` and `--access`; combining them is an error. Pi Pocket checks only the socket's own folder: **the folders above it** (`/run`, `/run/pi-pocket`) **must be root-owned and not writable by other users**, as above. Folder permissions are the boundary; the checks do not defend against root or the instance user changing them while the server runs.

For Alice, write an owner-only `0600` configuration file and a separate per-instance gateway secret as described in [Tailscale authentication](tailscale-auth.md):

```json
{
    "module": "/opt/pi-pocket/src/server/auth-providers/tailscale.ts",
    "options": {
        "secretFile": "/home/alice.name/.pi-pocket/gateway-secret"
    },
    "owner": "alice@example.com",
    "guestCapability": "example.com/cap/pi-pocket",
    "origin": "https://<host>.<tailnet>.ts.net"
}
```

The origin has **no path**, while the mount is `/alice.name`. Use actual full tailnet login names, the capability name Serve accepts (below), and the real checkout path. Every instance uses the same capability name, so one tailnet grant makes the developers guests on each other's instances. An instance can also, or instead, list guests by exact login: `"guests": ["bob@example.com"]`. A service for Alice starts the equivalent of:

```sh
PI_POCKET_AUTH_CONFIG=/home/alice.name/.pi-pocket/external-auth.json \
    node /opt/pi-pocket/bin/pi-pocket.js \
    --socket /run/pi-pocket/alice.name/pocket.sock \
    --base-path /alice.name --data /home/alice.name/.pi-pocket \
    --cwd /home/alice.name
```

The launcher's panel says to use the authenticated gateway: it prints no `http://` address, since none reaches a socket. Bob uses his own account, data/config/secret, owner login, socket folder (`/run/pi-pocket/bob.name`) and `/bob.name` mount. Guests are the members of the granted group, not every tailnet member or anyone sharing a display name. The capability is checked on every request: someone removed from the group is denied from their next request, and re-adding them restores the same person. A person removed in People stays revoked across browsers, restarts and the capability; do not delete external bindings to clean up configuration.

## Protect the gateway ingress first

Serve strips client-supplied identity headers and supplies the authenticated human's login. Pocket's provider also authenticates the gateway with a distinct secret for each instance. **Both boundaries matter:** an unprivileged local process must not reach the gateway and ask it to add a valid secret to a forged login. The backend sockets keep other users from receiving that secret; the gateway's own ingress needs the same protection.

The arrangement here puts Serve in front of Caddy on a Unix socket too, so no TCP port is involved anywhere on the host. Serve runs on the node itself (Tailscale **1.104.4 or later**, which fixes TS-2026-016 and TS-2026-017):

```sh
sudo tailscale serve --bg --https=443 \
    --accept-app-caps=example.com/cap/pi-pocket unix:/run/caddy-front/pocket.sock
```

Mounted at `/`, Serve keeps the `/<user>/` prefixes. Keep this single mount: TS-2026-017 let one mount's accepted app capabilities reach another. It strips client-supplied `Tailscale-User-*` and `Tailscale-App-Capabilities` headers, sets the verified login and, for the accepted capability, `Tailscale-App-Capabilities`, sets `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For`, and sends `Host: localhost` to a Unix target. Pocket builds its links from `X-Forwarded-Host`, and in external mode checks Origin against its configured origin, never against Host. Do not reset or replace unrelated Serve routes, and never enable Funnel for this one.

The administrator makes the ingress folder so that only Caddy and root can reach its socket (Caddy cannot set the socket's group itself; the setgid folder gives it `root`), and keeps Caddy's admin socket private:

```text
d /run/caddy-front 2750 caddy root  -
d /run/caddy       0700 caddy caddy -
```

In the tailnet policy, outside this repository, grant only the developers' group this node's `tcp:443` and the guest capability that Serve accepts (merge into the existing `grants`; group, tag and name are examples):

```json
{
    "grants": [
        {
            "src": ["group:developers@example.com"],
            "dst": ["tag:dev-machine"],
            "ip": ["tcp:443"],
            "app": {
                "example.com/cap/pi-pocket": [{ "role": "guest" }]
            }
        }
    ]
}
```

Only `{"role": "guest"}` admits; Pocket needs no capability for an owner, but each owner still needs network access to the node, here through the group. Removing someone from the group denies their next request on every instance, but an open event stream, a waiting long poll and Web Push notifications to subscriptions they registered continue until they are removed in People ([details](tailscale-auth.md#guests-by-app-capability)). When someone leaves the group, remove them in People on each instance (or through your admin procedure).

## Route without stripping the prefix

Caddy (2.11 or later) routes each fixed prefix to its instance's socket. Each instance's gateway secret is a file in `/etc/caddy/pocket-secrets/` (folder `0750`, files `0640`, owned by root with group `caddy`, readable by no other account), read by `{file.…}` when a request is proxied; since Caddy 2.8.5 it drops the file's trailing newline.

```text
{
    # Not localhost:2019, where any local user could read the configuration and replace the routes.
    admin unix//run/caddy/admin.sock
    servers {
        # Keep Serve's X-Forwarded-* headers, which arrive on the ingress socket.
        trusted_proxies_unix
    }
}

http://localhost {
    bind unix//run/caddy-front/pocket.sock|0660
    # No `log` directive: Caddy writes no access log. Never log request headers here.

    redir /alice.name /alice.name/ 308
    handle /alice.name/* {
        reverse_proxy unix//run/pi-pocket/alice.name/pocket.sock {
            header_up X-Pocket-Gateway-Secret {file./etc/caddy/pocket-secrets/alice.name}
            flush_interval -1
        }
    }

    redir /bob.name /bob.name/ 308
    handle /bob.name/* {
        reverse_proxy unix//run/pi-pocket/bob.name/pocket.sock {
            header_up X-Pocket-Gateway-Secret {file./etc/caddy/pocket-secrets/bob.name}
            flush_interval -1
        }
    }

    handle {
        respond 404
    }
}
```

Use `handle`, **not** `handle_path`: `handle_path` strips the prefix, and the backend must receive `/alice.name/...`, not `/...`. Caddy passes incoming headers through by default, so the `header_up` line must **overwrite** `X-Pocket-Gateway-Secret` on every route; never forward a caller-supplied one. A missing or empty secret file sends an empty value, which Pocket denies. The identity headers, `Tailscale-App-Capabilities` included, come only from Serve, which strips the client's own; Caddy passes them on unchanged. `flush_interval -1` sends SSE without buffering; Caddy sets no proxy read timeout, so long polls stay open. Pocket refuses every forwarded path outside its own mount, so a request whose path Caddy matches to one route but spells another prefix fails closed. Caddy's process (group `caddy`) reaches each instance socket through the folder's group; no other account can.

Never trust a forwarded-prefix header or route identity/secret selection from arbitrary request parameters. Preserve Origin as received; do not make hostile cross-origin requests look same-origin. Do not add shared response caches or authentication exceptions for static files, SSE, polling, artifacts or webhooks.

Opening the public prefixed address signs in through the external identity; no owner-token links, QR or invite code is needed. Tagged clients without a human login are denied.

## Alternative: nginx on a protected loopback port

A namespace-contained gateway is described in [Tailscale authentication](tailscale-auth.md). Another arrangement, when the host's `tailscaled` runs as UID 0, is a dedicated loopback gateway port protected by an administrator-owned UID firewall, with Serve forwarding to `http://127.0.0.1:880`. For example, these rules protect port `880` for IPv4 and IPv6:

```nft
 table inet pocket_gateway {
    chain input {
        type filter hook input priority -10; policy accept;
        iifname != "lo" tcp dport 880 reject with tcp reset
    }
    chain output {
        type filter hook output priority -10; policy accept;
        oifname "lo" tcp dport 880 meta skuid != 0 reject with tcp reset
    }
 }
```

This is a deployment example, not an automatically installed firewall. Validate and integrate it with the host's existing rules; load the protection **before** starting the listener and require it in gateway service dependencies. Keep it persistent across restarts. Confirm the actual tailscaled UID before relying on it. Root and its processes are trusted. An unprivileged account must not have capabilities or networking/proxy paths that bypass these rules. Never open this gateway port to the tailnet or public network, and never enable Funnel for it.

The firewall stops other users from **connecting** to the gateway port, not from **binding** it while the gateway restarts, which would let them answer Serve's traffic on the shared origin. So the gateway listens on a port below 1024 (`880` here): on Linux only root, or a process with `CAP_NET_BIND_SERVICE`, can bind one. Keep `net.ipv4.ip_unprivileged_port_start` at its default `1024`.

nginx then uses fixed `location` blocks to the same instance sockets. The root-owned secret include must contain `proxy_set_header X-Pocket-Gateway-Secret "<that instance's random secret>";` and must never be readable by other Unix users. Give the instance socket folders nginx's group instead of `caddy`.

```nginx
server {
    listen 127.0.0.1:880;
    server_name <host>.<tailnet>.ts.net;
    access_log off;

    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;

    location = /alice.name { return 308 /alice.name/; }
    location /alice.name/ {
        include /etc/pocket-gateway/common-headers.conf;
        include /etc/pocket-gateway/alice-secret.conf;
        proxy_pass http://unix:/run/pi-pocket/alice.name/pocket.sock;
    }

    location = /bob.name { return 308 /bob.name/; }
    location /bob.name/ {
        include /etc/pocket-gateway/common-headers.conf;
        include /etc/pocket-gateway/bob-secret.conf;
        proxy_pass http://unix:/run/pi-pocket/bob.name/pocket.sock;
    }

    location / { return 404; }
}
```

The root-owned `common-headers.conf` holds the seven shared headers:

```nginx
proxy_set_header Connection "";
proxy_set_header Host <host>.<tailnet>.ts.net;
proxy_set_header X-Forwarded-Host <host>.<tailnet>.ts.net;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header Tailscale-User-Login $http_tailscale_user_login;
proxy_set_header Tailscale-App-Capabilities $http_tailscale_app_capabilities;
proxy_set_header Tailscale-User-Name "";
```

Each location sets its own secret, and nginx inherits `proxy_set_header` only where a level sets none, so do not omit the common include. The `proxy_pass` targets have **no URI part** after the socket path: nginx then passes `/alice.name/...` unchanged.

## Validate before rollout

- Moving the instances to the Pi Pocket 0.28 base upgrades each data folder one way (Pi Durable 1.5, [architecture](architecture.md)): stop each instance and back up its whole data folder before its first start on 0.28. Going back to an older build needs that backup.
- The launcher's `--access tailscale-serve` (0.28) mounts Serve at `/` on the whole node. Behind a gateway it is refused: with `--socket` or `PI_POCKET_AUTH_CONFIG` the launcher runs no `tailscale serve` command at all, not to mount, adopt, or clear a stale mount (a receipt left in the data folder is only reported). The node's Serve route stays the administrator's.

- `tailscale version` is 1.104.4 or later, and `tailscale serve status` shows only the intended `https://<host>.<tailnet>.ts.net` → `unix:/run/caddy-front/pocket.sock` route at `/`, accepting the guest capability, with no Funnel.
- From a different unprivileged Unix account, the gateway ingress is unreachable (`curl --unix-socket /run/caddy-front/pocket.sock http://localhost/alice.name/` is refused, as is the admin socket), and direct backend requests with forged identity headers but no valid gateway secret are denied.
- No instance listens on TCP: `ss -ltnp` (as root) shows no Pocket backend port and no Caddy port. With the nginx alternative, the gateway's only listener is `127.0.0.1:880`, and `sysctl net.ipv4.ip_unprivileged_port_start` is `1024`.
- `/etc/caddy/pocket-secrets/*` are readable only by root and group `caddy`, and a request that carries its own `X-Pocket-Gateway-Secret` through Serve does not reach any instance with it.
- `ls -ld /run/pi-pocket /run/pi-pocket/*` shows a root-owned `0755` parent and per-user folders `drwxr-s---` owned by each instance user with the gateway's group; each `pocket.sock` is `srw-rw----` with that user and group. Another unprivileged account can neither create a file in a socket folder nor connect to a socket (`curl --unix-socket /run/pi-pocket/alice.name/pocket.sock http://x/alice.name/` is refused).
- Restarting an instance (Menu → Restart server, or its service) brings it back on the same socket; during the restart no other account can take its place. A copy of a socket folder made group-writable, or replaced by a symlink, makes Pocket refuse to start with exit code 78.
- The gateway's admin interface is not on a TCP port (with Caddy, `curl http://localhost:2019/config/` fails for every account) and its socket folder is private to the gateway.
- Forged identity and `Tailscale-App-Capabilities` headers sent through Serve do not override the real human identity or grant the capability. Missing and tagged identities, and people outside the granted group, are denied.
- Removing a guest from the granted group denies their next request without a restart (with the grant above they also lose the node's `tcp:443`; a person who can still reach it without the capability gets `403`); adding them back restores the same person. A person removed in People stays denied while still in the group, and their open event streams and Web Push notifications stop. Pocket admits the owner by login whether or not they hold the capability.
- The same human is owner on their instance and guest/viewer on another, never the other instance's owner. Native permissions, viewer downgrade, budget/session changes and removal persist across restart.
- Both prefixes load assets, SSE/poll, deep links, artifacts, themes and extensions. PWA install/share/notification URLs and browser state stay associated with the correct instance.
- Secrets are absent from browser responses and access/error/debug logs. Every instance runs under its intended UID/HOME with a different secret.

The automated tests exercise synthetic providers/gateway assertions and real browser startup, not a live tailnet or Linux firewall. Those deployment checks remain required.

**Paths are not browser security boundaries.** Cookies, caches and application storage are scoped to avoid accidental collisions, but same-origin scripts can access other paths and origin storage. Use only trusted browser extensions and collaborators here; use distinct origins and stronger execution isolation for hostile tenants. Guests that can steer already have the instance owner's tool/file rights.

Keep the checkout pinned to reviewed fork commits. Do not install public npm `pi-pocket` releases over it or automatically replace it with upstream code until upstream supports the same authentication and routing contract. The upstream proposals are [#275](https://github.com/TannerMidd/pi-pocket/issues/275) and [#276](https://github.com/TannerMidd/pi-pocket/issues/276).
