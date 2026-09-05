#!/bin/bash
# Build a signed Cloud Songs APK using the Android SDK build-tools directly
# (no Gradle needed - the app has no external dependencies, only framework +
# WebView classes). Produces android/dist/cloud-songs.apk.
set -e

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

rm -rf build dist
mkdir -p build/gen build/classes dist

echo "1/6 compile resources"
"$BT/aapt2" compile --dir res -o build/res.zip

echo "2/6 link resources + manifest"
"$BT/aapt2" link -o build/base.apk \
	-I "$PLATFORM" \
	--manifest AndroidManifest.xml \
	-R build/res.zip \
	--java build/gen \
	--min-sdk-version 23 --target-sdk-version 34 \
	--auto-add-overlay

echo "3/6 compile Java"
javac -source 17 -target 17 -d build/classes -classpath "$PLATFORM" \
	$(find src build/gen -name "*.java")

echo "4/6 dex"
"$BT/d8" --lib "$PLATFORM" --min-api 23 --output build \
	$(find build/classes -name "*.class")

echo "5/6 package dex into apk + align"
cp build/base.apk build/unsigned.apk
(cd build && zip -uj unsigned.apk classes.dex >/dev/null)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk

echo "6/6 sign"
if [ ! -f cloudsongs.keystore ]; then
	keytool -genkeypair -keystore cloudsongs.keystore -alias cloudsongs \
		-storepass cloudsongs -keypass cloudsongs -keyalg RSA -keysize 2048 \
		-validity 10000 -dname "CN=Cloud Songs, O=Cloud Songs, C=IN"
fi
"$BT/apksigner" sign --ks cloudsongs.keystore --ks-pass pass:cloudsongs \
	--key-pass pass:cloudsongs --out dist/cloud-songs.apk build/aligned.apk
"$BT/apksigner" verify --verbose dist/cloud-songs.apk | head -5

echo "APK ready: android/dist/cloud-songs.apk"
