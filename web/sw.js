// This is a classic worker: its registration scope is the server-provided mount, including its final slash.
const basePath = new URL(self.registration.scope).pathname.slice(0, -1);
const appUrl = (path) => basePath + path;
const inScope = (url) =>
    url.origin === self.location.origin && url.pathname.startsWith(basePath + "/");

// Pi Pocket's service worker. It shows push notifications (Pi finished, an approval, a chat message), answers an
// approval from its notification, opens the right session when one is tapped, and hands things shared to Pi Pocket
// from other apps to the page. It caches none of the app: the app is edited live.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Where shared things wait until the page picks them up; see `web/share.js`. */
const SHARE_CACHE = (basePath ? `pocket@${basePath}:` : "") + "pocket-share";

self.addEventListener("push", (event) => {
    let data = {};

    try {
        data = event.data?.json() ?? {};
    } catch {
        data = { title: "Pi Pocket", body: event.data?.text() ?? "" };
    }

    const approval = data.approval;
    // Allowing from the notification is offered only when the server says the whole call shows and this person may.
    const actions = approval
        ? [
              ...(approval.allow ? [{ action: "allow", title: "Allow" }] : []),
              { action: "deny", title: "Deny" },
          ]
        : [];

    event.waitUntil(
        Promise.all([
            self.registration.showNotification(data.title || "Pi Pocket", {
                body: data.body || "",
                tag: data.tag,
                renotify: Boolean(data.tag),
                icon: appUrl("/icon.svg"),
                actions,
                data: { url: data.url || appUrl("/"), approval },
            }),
            // A dot on the home-screen icon; the app sets the real count once it opens.
            self.navigator.setAppBadge?.().catch(() => {}),
        ]),
    );
});

/** Answer an approval with this device's sign-in. Only a failure shows: the notification going away is the answer. */
async function answerApproval(approval, allow, data) {
    let problem;

    try {
        const response = await fetch(appUrl(`/api/approvals/${encodeURIComponent(approval.id)}`), {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ allow }),
        });

        if (!response.ok) {
            problem =
                (await response.json().catch(() => ({}))).error ??
                `The server answered ${response.status}.`;
        }
    } catch {
        problem = "Pi Pocket could not be reached.";
    }

    if (problem === undefined) {
        return;
    }

    await self.registration.showNotification(`Could not ${allow ? "allow" : "deny"} the call`, {
        body: problem,
        icon: appUrl("/icon.svg"),
        data: { url: data.url },
    });
}

async function openUrl(url) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(url, self.location.origin);

    if (!inScope(target)) {
        return;
    }

    const open = windows.find((client) => inScope(new URL(client.url)));

    // PiP's notifications open its panel over whatever the window shows, rather than take the window elsewhere.
    if (open && new URL(url).searchParams.has("pip")) {
        await open.focus();
        open.postMessage({ type: "pocket.pip" });

        return;
    }

    if (open) {
        await open.focus();

        try {
            await open.navigate(url);

            return;
        } catch {
            // Not controlled by this worker yet: open a new window instead.
        }
    }

    await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data ?? {};

    if ((event.action === "allow" || event.action === "deny") && data.approval) {
        event.waitUntil(answerApproval(data.approval, event.action === "allow", data));

        return;
    }

    event.waitUntil(openUrl(new URL(data.url || appUrl("/"), self.location.origin).href));
});

/**
 * Something shared to Pi Pocket from another app (the manifest's share target) arrives as a form post. Keep it until
 * the page picks it up, then open the page to choose where it goes. Any website could post a form here too, and
 * nothing tells it apart from a share; it only fills in a message the person still reads and sends themselves.
 */
async function receiveShare(request) {
    let form;

    try {
        form = await request.formData();
    } catch {
        return Response.redirect(new URL(appUrl("/?share=failed"), self.location.origin).href, 303);
    }

    const id = crypto.randomUUID();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((file) => file instanceof File && file.size > 0);
    const text = (name) => (typeof form.get(name) === "string" ? form.get(name) : "");
    const meta = {
        title: text("title"),
        text: text("text"),
        url: text("url"),
        files: files.map((file) => ({ name: file.name, type: file.type })),
    };

    await cache.put(
        appUrl(`/share/${id}/meta`),
        new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }),
    );
    await Promise.all(
        files.map((file, index) =>
            cache.put(
                appUrl(`/share/${id}/file/${index}`),
                new Response(file, {
                    headers: { "content-type": file.type || "application/octet-stream" },
                }),
            ),
        ),
    );

    return Response.redirect(new URL(appUrl(`/?share=${id}`), self.location.origin).href, 303);
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (
        event.request.method === "POST" &&
        url.origin === self.location.origin &&
        url.pathname === appUrl("/share")
    ) {
        event.respondWith(receiveShare(event.request));
    }
});
