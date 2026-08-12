#!/bin/sh
# Signs the packaged mac app and dmg with an explicit certificate hash.
#
# Why not electron-builder's own signing: it passes the certificate NAME to
# codesign, and this keychain holds two same-named Developer ID certificates,
# which codesign rejects as ambiguous. A SHA-1 hash is never ambiguous.
#
# Usage:
#   npm run dist:mac            # builds unsigned, then runs this script
#   MAILMUX_SIGN_ID=<sha1> npm run dist:mac   # override the certificate
#
# Notarization (one-time credential setup, then per release):
#   xcrun notarytool store-credentials mailmux-notary \
#     --apple-id <apple-id> --team-id 22DPQ7YCAS
#   xcrun notarytool submit release/mailmux-*.dmg \
#     --keychain-profile mailmux-notary --wait
#   xcrun stapler staple release/mailmux-*.dmg
set -eu
cd "$(dirname "$0")/.."

ID="${MAILMUX_SIGN_ID:-403ADC00F0A6E8A510184F01AA2D670FA1988B54}"
APP=release/mac-arm64/mailmux.app
ENT=build/entitlements.mac.plist

# Inside-out: leaf binaries, frameworks, helpers, then the app itself.
codesign --force --timestamp --options runtime --sign "$ID" \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/"*.dylib
codesign --force --timestamp --options runtime --sign "$ID" \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"
find "$APP/Contents/Resources/app.asar.unpacked" -name "*.node" \
  -exec codesign --force --timestamp --options runtime --sign "$ID" {} \;
for f in "$APP/Contents/Frameworks/"*.framework; do
  codesign --force --timestamp --options runtime --sign "$ID" "$f"
done
for h in "$APP/Contents/Frameworks/"*Helper*.app; do
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$h"
done
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$APP"
codesign --verify --deep --strict "$APP"

# electron-builder wrote the dmg from the unsigned app. Rebuild the image
# from this signed copy, or the download still contains an unsigned .app.
npx electron-builder --mac dmg --prepackaged release/mac-arm64 -c.mac.identity=null

for dmg in release/mailmux-*.dmg; do
  [ -e "$dmg" ] || continue
  codesign --force --timestamp --sign "$ID" "$dmg"
  codesign --verify "$dmg"
done
echo "signed with $ID"
