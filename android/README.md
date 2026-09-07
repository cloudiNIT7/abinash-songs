# Cloud Songs — Android app

A minimal WebView shell that runs the Cloud Songs web app
(https://abinash-songs.pages.dev) as a native Android application.

- Keeps you signed in (cookies + DOM storage persist).
- Plays audio, supports the profile-photo file picker.
- Hardware Back steps through in-app history.

## Build

Requires a JDK (17) and the Android SDK (platform 34 + build-tools 34.0.0).

### With push notifications (Gradle — recommended)

Sign-in-approval notifications reaching a **closed** app need Firebase Cloud
Messaging, which pulls the `firebase-messaging` SDK, so this build uses Gradle:

```sh
cd android
gradle assembleRelease        # or ./gradlew assembleRelease if a wrapper is added
# -> android/build/outputs/apk/release/*.apk
```

`google-services.json` (already committed) wires the app to the Firebase project
`gen-lang-client-0680456004`. The `com.google.gms.google-services` plugin reads
it at build time. `CloudSongsFirebaseService` receives the wake-up and shows the
Approve/Deny prompt; `MainActivity` fetches the FCM token and registers it with
the server through `window.CloudSongsFCM`.

The server side needs the `FCM_SERVICE_ACCOUNT` secret set on the Cloudflare
project (see DEPLOY.md → "Sign-in approvals"). Without it, FCM is simply off and
Web Push / in-app polling carry on.

### Without push (no Gradle, legacy)

The original no-dependency build still works for a WebView-only APK without FCM:

```sh
cd android
./build-apk.sh
# -> android/dist/cloud-songs.apk
```

It compiles resources with `aapt2`, javac + `d8` for the dex, then `zipalign` +
`apksigner` sign it. Note: this build does **not** include the Firebase classes,
so `CloudSongsFirebaseService`/`MainActivity`'s FCM calls are absent — closed-app
approval notifications require the Gradle build above.

## Install

Copy `cloud-songs.apk` to a phone and open it (enable "install unknown apps"),
or `adb install android/dist/cloud-songs.apk`.

The signed APK for each version is attached to the repo's GitHub Releases.
