# Cloud Songs — iOS app

A `WKWebView` shell that runs the Cloud Songs web app
(https://abinash-songs.pages.dev) as a native iOS application — the counterpart
of `android/`, with the same feature set.

- Keeps you signed in (cookies + `localStorage` persist on disk).
- Plays audio in the background and with the screen locked.
- Lock screen / Control Center controls: cover, title, artist, scrubber and
  prev / play-pause / next, wired to the web player.
- A "Now playing" banner when a new song starts.
- Sign-in approval alerts, delivered over APNs, that reach a **closed** app.
- "Listen to this" suggestion notifications, with album art.
- Profile photo picker (`<input type="file">`), handled by WebKit.
- Swipe from the left edge to go back through in-app history (iOS has no
  hardware Back key).

## Layout

| Path | What it is |
| --- | --- |
| `CloudSongs/AppDelegate.swift` | Lifecycle, the `.playback` audio session, APNs callbacks |
| `CloudSongs/PlayerViewController.swift` | The web view, the JS bridge, the offline fallback |
| `CloudSongs/BridgeScript.swift` | JavaScript injected into every page (see below) |
| `CloudSongs/NowPlayingCenter.swift` | `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` |
| `CloudSongs/Notifications.swift` | Permission, the now-playing banner, push handling |
| `CloudSongs/PushRegistration.swift` | Registers the APNs token against the account |
| `CloudSongs/Config.swift` | Site URL, colours, behaviour switches |
| `CloudSongsNotify/` | Notification-service extension: attaches album art to a push |
| `CloudSongs.xcodeproj` | The project, hand-written so it opens with nothing else installed |
| `project.yml` | The same project as XcodeGen input, if you'd rather regenerate it |
| `tools/mkicon.swift` | Flattens `assets/pwa-512.png` into the 1024px opaque app icon |
| `tools/apns-selftest.mjs`, `tools/push-selftest.mjs` | Server-side APNs checks, no network |

## How it maps onto the Android app

| Android | iOS |
| --- | --- |
| `MainActivity` (WebView + JS bridge) | `PlayerViewController` |
| `PlaybackService` (foreground service, MediaSession, media notification) | `.playback` audio session + `audio` background mode + `NowPlayingCenter` |
| Heads-up "Now playing" channel | A passive local notification, posted only while backgrounded |
| `CloudSongsFirebaseService` (FCM) | APNs straight from the Worker + `Notifications` |
| `window.AndroidMedia` | The same object, posting to a `WKScriptMessageHandler` |
| `window.CloudSongsControl` | Unchanged — the same transport contract |
| `window.CloudSongsFCM.register` → `/api/me/fcm` | `window.CloudSongsAPNs.register` → `/api/me/apns` |

Nothing in the web app had to change for iOS: `BridgeScript.swift` defines the
same `window.AndroidMedia` the page already looks for, and installs the same
`CloudSongsControl` fallback the APK injects when the page has no Media Session.

There is no Firebase SDK here. iOS hands the app an APNs device token directly,
so the server pushes to Apple itself (`functions/_lib/apns.js`) — one less
dependency in the app and one less console to configure.

## Build

Xcode 15 or newer, and an Apple ID in Xcode (Settings → Accounts).

```sh
open ios/CloudSongs.xcodeproj
```

Then set your team once: select the **CloudSongs** target → Signing &
Capabilities → Team. Do the same for **CloudSongsNotify**. Change the bundle ids
from `com.cloudsongs.app` / `com.cloudsongs.app.notify` if that identifier is not
yours, and keep the extension id as `<app id>.notify`.

Command line, if you prefer:

```sh
cd ios
xcodebuild -project CloudSongs.xcodeproj -scheme CloudSongs \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
```

To regenerate the project instead of editing the pbxproj by hand:

```sh
brew install xcodegen
cd ios && xcodegen generate
```

### Capabilities

The checked-in project already carries what the app needs:

- **Background Modes** → Audio and Remote notifications (`Info.plist`,
  `UIBackgroundModes`).
- **Push Notifications** → `CloudSongs.entitlements` (`aps-environment`).

Push Notifications requires a paid Apple Developer account. On a free personal
team the app still builds, installs and plays music; APNs registration fails,
which is logged and otherwise ignored — the in-app approval poll keeps working,
exactly like an APK built without Firebase.

## Install on a device

With a cable and Xcode: select your iPhone in the toolbar and press Run. A free
personal team's build expires after 7 days and has to be re-run; a paid team's
lasts a year.

For anyone else: Product → Archive → Distribute App → TestFlight. There is no
side-loading equivalent of the `.apk` on iOS, which is why the download page
still only offers the Android build.

## Push notifications

The app registers its APNs token with the site, and the Worker pushes to Apple
directly. Server setup — the `.p8` key, the secrets and the migration — is in
[../DEPLOY.md](../DEPLOY.md#the-installed-ios-app-apns).

What arrives, and from where:

| Notification | Path |
| --- | --- |
| Sign-in approval | `pushToUser` → `apnsToUser` → APNs → system alert → tap → the page's own Approve/Deny prompt |
| Listening suggestion | cron → `suggestToUser` → APNs → system alert, art added by the extension |
| Now playing | Local, posted by the app itself when a new song starts while backgrounded |

To check the plumbing without a device:

```sh
node ios/tools/apns-selftest.mjs     # provider JWT + request shape
node ios/tools/push-selftest.mjs     # token store + fan-out
```

## Notes and knobs

- `Config.siteURL` — which deployment to load. `Config.allowedHosts` decides what
  stays in the app; everything else opens in Safari.
- `Config.nowPlayingOwnership` — iOS 16.4+ lets WebKit publish the lock-screen
  panel from the page's own Media Session, and the page uses it, so by default
  the app does not write metadata on top of it. Set it to `.always` if the lock
  screen ever comes up empty.
- `Config.showNowPlayingBanner` — turn the per-song banner off.
- Version numbers live in `CloudSongs/Info.plist` — 1.3.0 (build 19) for the
  first iOS release. The two platforms are versioned independently, so the APK
  stays at 1.2.1 / 18 in `android/AndroidManifest.xml` until its next build.
- The app icon is generated, not hand-drawn:
  `swift tools/mkicon.swift ../assets/pwa-512.png CloudSongs/Assets.xcassets/AppIcon.appiconset/icon-1024.png 1024`.
