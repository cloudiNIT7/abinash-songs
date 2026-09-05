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
	--min-sdk-version 21 --target-sdk-version 34 \
	--auto-add-overlay

echo "3/6 compile Java"
javac -source 8 -target 8 -d build/classes -classpath "$PLATFORM" \
	-bootclasspath "$PLATFORM" \
	$(find src build/gen -name "*.java") 2>/dev/null || \
javac -source 8 -target 8 -d build/classes -classpath "$PLATFORM" \
	$(find src build/gen -name "*.java")

echo "4/6 dex"
"$BT/d8" --lib "$PLATFORM" --min-api 21 --output build \
	$(find build/classes -name "*.class")

echo "5/6 package dex into apk + align"
# Assemble the unsigned APK deterministically with Python's zipfile: copy every
# entry from the aapt2 output (keeping resources.arsc STORED) and add classes.dex.
# Avoids any macOS `zip -u` quirks that some package parsers reject.
python3 - "$PWD/build/base.apk" "$PWD/build/classes.dex" "$PWD/build/unsigned.apk" <<'PYEOF'
import sys, zipfile, shutil
base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(base) as zin, zipfile.ZipFile(out, "w") as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        # Preserve STORED for resources.arsc (required uncompressed on API 30+);
        # deflate everything else.
        comp = zipfile.ZIP_STORED if item.filename == "resources.arsc" else zipfile.ZIP_DEFLATED
        zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
        zi.compress_type = comp
        zi.external_attr = item.external_attr
        zout.writestr(zi, data)
    with open(dex, "rb") as f:
        dexdata = f.read()
    zi = zipfile.ZipInfo("classes.dex")
    zi.compress_type = zipfile.ZIP_DEFLATED
    zout.writestr(zi, dexdata)
print("assembled", out)
PYEOF
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

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
