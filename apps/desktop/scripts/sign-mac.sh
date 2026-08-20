#!/bin/sh
# Signs and notarises the packaged mac app and dmg.
#
# A Developer ID signature alone is not enough. macOS refuses to open a
# downloaded app that Apple has not notarised: "Apple could not verify
# Boxaide is free of malware." Notarisation is a separate upload to Apple,
# and the returned ticket must be stapled into the app AND the dmg.
#
# Why not electron-builder's own signing: it passes the certificate NAME to
# codesign, and this keychain holds two same-named Developer ID certificates,
# which codesign rejects as ambiguous. A SHA-1 hash is never ambiguous.
#
# One-time credential setup. The keychain profile name is historical.
#   xcrun notarytool store-credentials mailmux-notary \
#     --apple-id <apple-id> --team-id 22DPQ7YCAS
#
# Usage:
#   APPLE_KEYCHAIN_PROFILE=mailmux-notary npm run dist:mac   # sign + notarise
#   npm run dist:mac                                          # sign only
#   BOXAIDE_SIGN_ID=<sha1> npm run dist:mac                      # other cert
#
# Without APPLE_KEYCHAIN_PROFILE this script signs and skips notarisation.
# That build is for local testing only. scripts/ship.sh refuses to publish it.
set -eu
cd "$(dirname "$0")/.."

ID="${BOXAIDE_SIGN_ID:-${MAILMUX_SIGN_ID:-403ADC00F0A6E8A510184F01AA2D670FA1988B54}}"
APP=release/mac-arm64/Boxaide.app
ENT=build/entitlements.mac.plist

# Inside-out: leaf binaries, frameworks, helpers, then the app itself.
codesign --force --timestamp --options runtime --sign "$ID" \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/"*.dylib
codesign --force --timestamp --options runtime --sign "$ID" \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"
find "$APP/Contents/Resources/app.asar.unpacked" -name "*.node" \
  -exec codesign --force --timestamp --options runtime --sign "$ID" {} \;

# The EventKit helper. Hardened runtime, no entitlements: it is not V8 and
# needs neither JIT key, and the calendar entitlement belongs to the app rather
# than here — macOS charges a bundle-less helper's request to the responsible
# process and reads the entitlement from that. Signing the helper with it and
# the app without was measured, and the permission dialog still never appeared.
# Unsigned it fails --deep --strict below, and notarisation after that.
# An `if`, not a `&&` chain: under `set -e` a false test is a failed command
# and would abort the whole signing run whenever the helper is absent.
HELPER="$APP/Contents/Resources/boxaide-calendar"
if [ -f "$HELPER" ]; then
  codesign --force --timestamp --options runtime --sign "$ID" "$HELPER"
fi

# A framework can carry its own helper executables, and signing the framework
# only seals those as resources — it does not sign them as code. Squirrel's
# updater, Resources/ShipIt, is one, and notarisation rejected the whole app
# over it. Sweep every Mach-O file under Frameworks rather than naming the
# ones we know: a new Electron drops in new helpers without warning.
# The bundle passes below re-sign their own main executables afterwards,
# entitlements and all, so signing those twice is harmless.
find "$APP/Contents/Frameworks" -type f -perm -u+x | while IFS= read -r bin; do
  case "$(file -b "$bin")" in
    *Mach-O*) codesign --force --timestamp --options runtime --sign "$ID" "$bin" ;;
  esac
done

for f in "$APP/Contents/Frameworks/"*.framework; do
  codesign --force --timestamp --options runtime --sign "$ID" "$f"
done
for h in "$APP/Contents/Frameworks/"*Helper*.app; do
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$h"
done
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$APP"
codesign --verify --deep --strict "$APP"

PROFILE="${APPLE_KEYCHAIN_PROFILE:-}"

# Notarise the app before the dmg is built, so the ticket travels inside the
# image. An app copied out of a dmg that only carries its own ticket needs a
# network round trip to Apple on first launch; a stapled app never does.
if [ -n "$PROFILE" ]; then
  echo "notarising the app with profile $PROFILE"
  rm -f release/boxaide-app.zip
  ditto -c -k --keepParent "$APP" release/boxaide-app.zip
  xcrun notarytool submit release/boxaide-app.zip \
    --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f release/boxaide-app.zip
else
  echo "APPLE_KEYCHAIN_PROFILE is not set — skipping notarisation"
fi

# electron-builder wrote the dmg from the unsigned app. Rebuild the image
# from this signed copy, or the download still contains an unsigned .app.
# The path is the .app itself — passing the parent folder nests Boxaide.app
# inside another Boxaide.app.
#
# The zip is built in the same pass, and it matters that it is this pass:
# Squirrel refuses an update whose signature does not match the running app,
# so the zip must hold the signed, stapled bundle, not the one electron-builder
# packed before this script ran. This pass also writes release/latest-mac.yml,
# the sha512 of that exact zip. Ship all three or none.
npx electron-builder --mac dmg zip --prepackaged release/mac-arm64/Boxaide.app -c.mac.identity=null --publish never

for dmg in release/boxaide-*.dmg; do
  [ -e "$dmg" ] || continue
  codesign --force --timestamp --sign "$ID" "$dmg"
  codesign --verify "$dmg"
  [ -n "$PROFILE" ] || continue
  echo "notarising $dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$dmg"
done

# An update the app cannot find is the same as no update. Both files are
# produced by the pass above; if either is missing the publish must not go
# ahead with a dmg alone, because the running app would keep reporting the old
# version forever and nobody would see a failure.
for required in release/boxaide-mac.dmg release/boxaide-mac.zip release/latest-mac.yml; do
  [ -f "$required" ] || {
    echo "missing $required — required release artifact was not built" >&2
    exit 1
  }
done

if [ -n "$PROFILE" ]; then
  # The gate the user's Mac applies. Anything else here ships a broken
  # download, so fail the build instead of the install.
  spctl --assess --type exec --verbose=2 "$APP"
  xcrun stapler validate "$APP"
  echo "signed and notarised with $ID"
else
  echo "signed with $ID — NOT notarised, do not publish this build"
fi
