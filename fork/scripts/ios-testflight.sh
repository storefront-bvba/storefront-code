#!/bin/bash
# Build Storefront Code for iOS and upload it to TestFlight. Runs on the build Mac.
#
#   ASC_KEY_ID=… ASC_ISSUER_ID=… fork/scripts/ios-testflight.sh
#
# Needs Xcode (the version upstream builds with, see fork/GOAL-CURRENT-STATUS.md), mise with
# node@26.13.1 and pnpm@12.14.0, CocoaPods, `pnpm install` done, and the App Store Connect API key
# in ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (or ASC_KEY_PATH).
# Signing is automatic: Xcode creates or reuses certificates, App Groups and profiles through the
# API key. Over SSH the login keychain is locked; KEYCHAIN_PASSWORD_FILE unlocks it for the build.
#
# Optional: APP_VARIANT (production), BUILD_NUMBER (UTC timestamp), UPLOAD=0 to stop after export.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$PWD
: "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
TEAM_ID=$(sed -n 's/^export const STOREFRONT_APPLE_TEAM_ID = "\(.*\)";$/\1/p' apps/mobile/storefront-identity.ts)
VARIANT="${APP_VARIANT:-production}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
UPLOAD="${UPLOAD:-1}"
OUT="$ROOT/build/ios/$BUILD_NUMBER"

[ -f "$KEY_PATH" ] || { echo "API key not found: $KEY_PATH" >&2; exit 1; }
[ -n "$TEAM_ID" ] || { echo "STOREFRONT_APPLE_TEAM_ID is empty" >&2; exit 1; }

export PATH="/opt/homebrew/bin:$PATH" LANG=en_US.UTF-8 EXPO_NO_GIT_STATUS=1 CI=1
export APP_VARIANT="$VARIANT" STOREFRONT_BUILD_NUMBER="$BUILD_NUMBER" T3CODE_MOBILE_UPDATES_ENABLED=0
run() { mise exec node@26.13.1 pnpm@12.14.0 -- "$@"; }

echo "== Storefront Code $VARIANT, build $BUILD_NUMBER, commit $(git rev-parse --short HEAD)"
run node fork/scripts/check-telemetry.mjs

if [ -n "${KEYCHAIN_PASSWORD_FILE:-}" ]; then
	security unlock-keychain -p "$(cat "$KEYCHAIN_PASSWORD_FILE")" "$HOME/Library/Keychains/login.keychain-db"
	security set-keychain-settings -t 7200 "$HOME/Library/Keychains/login.keychain-db"
fi

(cd apps/mobile && run pnpm exec expo prebuild --clean --platform ios)

WORKSPACE=$(ls -d apps/mobile/ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
AUTH=(-allowProvisioningUpdates
	-authenticationKeyPath "$KEY_PATH"
	-authenticationKeyID "$ASC_KEY_ID"
	-authenticationKeyIssuerID "$ASC_ISSUER_ID")
mkdir -p "$OUT"

echo "== archive $SCHEME"
# xcodebuild runs the Metro bundling build phase; it needs node from mise on PATH.
run xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
	-destination generic/platform=iOS -archivePath "$OUT/$SCHEME.xcarchive" "${AUTH[@]}" \
	DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
	archive 2>&1 | tee "$OUT/archive.log" | grep -E '^(error|warning: .*sign|\*\* )|BUILD|ARCHIVE' || true
[ -d "$OUT/$SCHEME.xcarchive" ] || { echo "archive failed, see $OUT/archive.log" >&2; exit 1; }

DESTINATION=export
[ "$UPLOAD" = 1 ] && DESTINATION=upload
cat >"$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>$DESTINATION</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>signingStyle</key><string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>uploadSymbols</key><true/>
	<key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST

echo "== export ($DESTINATION)"
xcodebuild -exportArchive -archivePath "$OUT/$SCHEME.xcarchive" \
	-exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}" \
	2>&1 | tee "$OUT/export.log" | grep -E '^(error|\*\* )|EXPORT|Upload|upload' || true
grep -q 'EXPORT SUCCEEDED' "$OUT/export.log" || { echo "export failed, see $OUT/export.log" >&2; exit 1; }
echo "== done: build $BUILD_NUMBER ($DESTINATION). Logs in $OUT"
