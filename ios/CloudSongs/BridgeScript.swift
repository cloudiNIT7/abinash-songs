import Foundation

/**
 The JavaScript that makes the web player and the native shell talk to each
 other. Injected into every page at document start.

 It is deliberately the *same contract* the Android app uses:

 - `window.AndroidMedia.updateMetadata / updatePlayback` - the page already
   calls these when a native shell is present (`nativeMediaMeta()` /
   `nativeMediaState()` in `Spotify-songs/songs.html`), so nothing in the web app
   has to change for iOS. Here they post to the `cloudSongs` message handler.
 - `window.CloudSongsControl` - what the lock screen / Control Center buttons
   drive. The page defines it inside `setupMediaSession()`, which returns early
   when the Media Session API is missing; on those (older) systems the fallback
   below drives the player's real transport buttons instead, exactly as the APK
   does.
 - A DOM watcher, so pages that do not push metadata themselves still report the
   current track.
 */
enum BridgeScript {

	/// Name of the `WKScriptMessageHandler` the shim posts to.
	static let handlerName = "cloudSongs"

	static let source = #"""
	(function () {
	try {
		if (window.__csNative) return;
		window.__csNative = 1;

		function post(msg) {
			try { window.webkit.messageHandlers.cloudSongs.postMessage(msg); } catch (e) {}
		}

		/* ---- the contract the page already speaks ---- */
		window.AndroidMedia = {
			updateMetadata: function (title, artist, art) {
				post({ type: "meta", title: title || "", artist: artist || "", art: art || "" });
			},
			updatePlayback: function (playing, position, duration) {
				post({
					type: "state",
					playing: !!playing,
					position: Number(position) || 0,
					duration: Number(duration) || 0
				});
			}
		};
		window.CloudSongsNative = { platform: "ios" };

		/* ---- APNs token registration ---- */
		/* Called from the shell once iOS hands it a device token. Runs in the
		 * page so the session cookie rides along on the same-origin request;
		 * the shell never has to know anything about the login. */
		window.CloudSongsAPNs = {
			register: function (token, path, env) {
				if (!token) return;
				fetch(path || "/api/me/apns", {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token: token, platform: "ios", env: env || "production" })
				}).then(function (r) {
					post({ type: "apns", ok: !!r.ok, status: r.status | 0 });
				}).catch(function () {
					post({ type: "apns", ok: false, status: 0 });
				});
			}
		};

		/* ---- report what this page can do ---- */
		function announce() {
			post({
				type: "ready",
				mediaSession: !!(navigator.mediaSession && "metadata" in navigator.mediaSession),
				url: location.href
			});
		}

		/* ---- metadata watcher (same shape as the APK's) ---- */
		function A() { return document.querySelector("audio"); }

		function tx(id, sel) {
			var e = id ? document.getElementById(id) : null;
			if (!e && sel) e = document.querySelector(sel);
			if (!e) return "";
			var t = (e.textContent || "").trim();
			if (!t || t === "Nothing playing" || t === "\u2014") return "";
			return t;
		}

		function im() {
			var ids = ["ctArt", "npArt", "playingArt", "heroArt"];
			for (var i = 0; i < ids.length; i++) {
				var e = document.getElementById(ids[i]);
				if (e && e.src && e.src.indexOf("data:") !== 0 && e.src.indexOf("icon.png") < 0) return e.src;
			}
			return "";
		}

		var lastT = "", lastA = "", lastArt = "";
		function meta() {
			try {
				var t = tx("ctTitle", ".playing__song__name") || tx("npTitle", null);
				var ar = tx("ctArtist", ".playing__song__artist") || tx("npArtist", null);
				var g = im();
				if (t && (t !== lastT || ar !== lastA || g !== lastArt)) {
					lastT = t; lastA = ar; lastArt = g;
					window.AndroidMedia.updateMetadata(t, ar, g);
				}
			} catch (e) {}
		}

		function state() {
			try {
				var a = A();
				if (a) window.AndroidMedia.updatePlayback(!a.paused, Math.floor((a.currentTime || 0) * 1000), Math.floor((a.duration || 0) * 1000));
			} catch (e) {}
		}

		function both() { meta(); state(); }

		/* ---- transport fallback ---- */
		/* The page only defines window.CloudSongsControl inside
		 * setupMediaSession(), which bails out when navigator.mediaSession is
		 * missing. Install a working implementation that clicks the player's
		 * real buttons so the native controls still do something there. */
		function btn() {
			for (var i = 0; i < arguments.length; i++) {
				var a = arguments[i];
				var e = a.charAt(0) === "." ? document.querySelector(a) : document.getElementById(a);
				if (e) return e;
			}
			return null;
		}
		var PLAY = function () { return btn("npPlay", ".current-track__actions .play"); };
		var NEXT = function () { return btn("npNext", "ctNext"); };
		var PREV = function () { return btn("npPrev", "ctPrev"); };

		function installFallbackControl() {
			if (window.CloudSongsControl) return;
			window.CloudSongsControl = {
				toggle: function () {
					var b = PLAY();
					if (b) { b.click(); return; }
					var a = A();
					if (a) { if (a.paused) a.play(); else a.pause(); }
				},
				play: function () { var a = A(); if (!a || a.paused) this.toggle(); },
				pause: function () { var a = A(); if (a && !a.paused) this.toggle(); },
				next: function () { var b = NEXT(); if (b) b.click(); },
				prev: function () { var b = PREV(); if (b) b.click(); },
				seek: function (ms) { var a = A(); if (a) { try { a.currentTime = (ms || 0) / 1000; } catch (e) {} } }
			};
		}

		function boot() {
			installFallbackControl();
			announce();
			both();
		}

		document.addEventListener("play", both, true);
		document.addEventListener("pause", both, true);
		document.addEventListener("loadedmetadata", both, true);
		document.addEventListener("durationchange", both, true);
		document.addEventListener("ended", both, true);

		/* One second is enough to keep the elapsed time honest without waking
		 * the page needlessly; iOS suspends these timers in the background
		 * anyway, where the shell extrapolates the position itself. */
		setInterval(function () {
			var a = A();
			if (a && a.src) { meta(); if (!a.paused) state(); }
		}, 1000);

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", boot);
			/* The page's own setupMediaSession() may run after us; re-announce
			 * shortly after load so we learn about a CloudSongsControl it
			 * installed itself. */
			window.addEventListener("load", function () { setTimeout(boot, 300); });
		} else {
			boot();
		}
	} catch (e) {}
	})();
	"""#
}
