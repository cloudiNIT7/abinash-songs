/* Service worker.
 *
 * Two jobs:
 *   1. Make the app installable (Add to Home Screen) and launch standalone. The
 *      fetch handler is a deliberate pass-through - no API or media caching.
 *   2. Raise sign-in approval requests as system notifications. On Android
 *      `new Notification()` does not exist, and on a phone the tab is usually
 *      closed anyway, so notifications have to come from here.
 *
 * Pushes carry no payload: this worker wakes, asks the API what is waiting and
 * draws the notification itself. Nothing about the account travels in the push.
 */

const APPROVAL_TAG = "cs-approval";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
	// Pass through to the network; let the browser/edge handle caching.
	e.respondWith(fetch(e.request).catch(function () { return new Response("", { status: 504 }); }));
});

function describe(a) {
	var bits = [a.browser, a.os].filter(Boolean);
	return bits.length ? bits.join(" on ") : (a.device || "a new device");
}
function detail(a) {
	return [a.device, a.location, a.ip].filter(Boolean).join(" \u00b7 ");
}

function showApproval(a) {
	return self.registration.showNotification("Approve sign-in to Cloud Songs?", {
		body: describe(a) + (detail(a) ? "\n" + detail(a) : ""),
		tag: APPROVAL_TAG + "-" + a.id,     // replaces itself instead of stacking
		icon: "/assets/pwa-192.png",
		badge: "/assets/pwa-192.png",
		vibrate: [90, 50, 90],
		requireInteraction: true,           // stays up until it is answered
		renotify: true,
		data: { kind: "approval", id: a.id },
		actions: [
			{ action: "approve", title: "Approve" },
			{ action: "deny", title: "Deny" },
		],
	});
}

/** What is waiting for an answer? Cookies ride along: same-origin request. */
function pendingApprovals() {
	return fetch("/api/me/approvals", { credentials: "same-origin", cache: "no-store" })
		.then(function (r) { return r.ok ? r.json() : null; })
		.then(function (d) { return (d && d.approvals) || []; })
		.catch(function () { return []; });
}

function answer(id, action) {
	return fetch("/api/me/approvals", {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: id, action: action }),
	}).then(function (r) { return r.ok; }).catch(function () { return false; });
}

/** Let any open tab know, so its own pop-up and list stay in step. */
function tellClients(message) {
	return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
		list.forEach(function (c) { try { c.postMessage(message); } catch (e) {} });
	});
}

self.addEventListener("push", function (event) {
	// The push is only a nudge - ask what it was about.
	event.waitUntil(
		pendingApprovals().then(function (list) {
			if (!list.length) {
				// Nothing pending any more (already answered elsewhere). Chrome
				// insists a push shows something, so keep it honest and brief.
				return self.registration.showNotification("Cloud Songs", {
					body: "A sign-in request was already handled.",
					tag: APPROVAL_TAG,
					icon: "/assets/pwa-192.png",
				});
			}
			return Promise.all(list.slice(0, 3).map(showApproval))
				.then(function () { return tellClients({ type: "cs-approvals", approvals: list }); });
		}),
	);
});

self.addEventListener("notificationclick", function (event) {
	var data = event.notification.data || {};
	var action = event.action;
	event.notification.close();

	if (data.kind === "approval" && (action === "approve" || action === "deny")) {
		// Answered straight from the notification, without opening the app.
		event.waitUntil(
			answer(data.id, action).then(function (ok) {
				return tellClients({ type: "cs-approval-answered", id: data.id, action: action, ok: ok });
			}),
		);
		return;
	}

	// Tapped the body: bring the app forward (or open it) so the pop-up shows.
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
			for (var i = 0; i < list.length; i++) {
				if (list[i].url.indexOf("/Spotify-songs/songs") > -1) return list[i].focus();
			}
			return self.clients.openWindow("/Spotify-songs/songs.html");
		}),
	);
});

// The page asks for a notification when it cannot raise one itself (Android has
// no Notification constructor in a page).
self.addEventListener("message", function (event) {
	var msg = event.data || {};
	if (msg.type === "cs-show-approval" && msg.approval) {
		event.waitUntil(showApproval(msg.approval));
	} else if (msg.type === "cs-close-approval" && msg.id) {
		event.waitUntil(
			self.registration.getNotifications({ tag: APPROVAL_TAG + "-" + msg.id }).then(function (list) {
				list.forEach(function (n) { n.close(); });
			}),
		);
	}
});
