# Cloud Songs — Android app

A minimal WebView shell that runs the Cloud Songs web app
(https://abinash-songs.pages.dev) as a native Android application.

- Keeps you signed in (cookies + DOM storage persist).
- Plays audio, supports the profile-photo file picker.
- Hardware Back steps through in-app history.

## Build

Requires a JDK (17) and the Android SDK (platform 34 + build-tools 34.0.0).
No Gradle needed — the app has no external dependencies.

```sh
cd android
./build-apk.sh
# -> android/dist/cloud-songs.apk
```

The build compiles resources with `aapt2`, javac + `d8` for the dex, then
`zipalign` + `apksigner` sign it with a local `cloudsongs.keystore` (created on
first run; not committed).

## Install

Copy `cloud-songs.apk` to a phone and open it (enable "install unknown apps"),
or `adb install android/dist/cloud-songs.apk`.

The signed APK for each version is attached to the repo's GitHub Releases.
