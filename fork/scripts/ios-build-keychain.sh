#!/bin/bash
# Set up and unlock the Storefront build keychain on the build Mac.
#
# Over SSH the login keychain is locked and unlocking it needs the user's password. Signing uses
# this separate keychain instead: its random password lives in a file only this user can read,
# and it holds our own Apple Development and Apple Distribution identities, created through the
# App Store Connect API from keys generated here (the private keys never leave this Mac).
# Run it in the same session as the build (fork/scripts/ios-testflight.sh does). Idempotent.
#
# Needs ASC_KEY_ID and ASC_ISSUER_ID for the first run (certificate creation).
set -euo pipefail

cd "$(dirname "$0")/../.."
KEYCHAIN="$HOME/Library/Keychains/storefront-build.keychain-db"
PASSWORD_FILE="$HOME/.config/storefront-code/build-keychain-password"
export PATH="/opt/homebrew/bin:$PATH"

if [ ! -s "$PASSWORD_FILE" ]; then
	(umask 077 && mkdir -p "$(dirname "$PASSWORD_FILE")" && openssl rand -base64 30 >"$PASSWORD_FILE")
fi
PASSWORD=$(cat "$PASSWORD_FILE")

if [ ! -f "$KEYCHAIN" ]; then
	security create-keychain -p "$PASSWORD" "$KEYCHAIN"
	echo "created $KEYCHAIN"
fi
# No auto-lock timeout; it is unlocked per build anyway.
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"

# Keep the user's keychains and add ours to the search list, so Xcode and codesign find it.
search_list=()
while IFS= read -r line; do
	line="${line#"${line%%[![:space:]]*}"}"
	line="${line%\"}"
	search_list+=("${line#\"}")
done < <(security list-keychains -d user)
if ! printf '%s\n' "${search_list[@]}" | grep -qxF "$KEYCHAIN"; then
	security list-keychains -d user -s "${search_list[@]}" "$KEYCHAIN"
	echo "added the build keychain to the search list"
fi

identity() { security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$1: "; }

for type in DEVELOPMENT DISTRIBUTION; do
	label="Apple Development"
	[ "$type" = DISTRIBUTION ] && label="Apple Distribution"
	identity "$label" && continue
	: "${ASC_KEY_ID:?set ASC_KEY_ID to create certificates}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	openssl genrsa -out "$work/key.pem" 2048 2>/dev/null
	openssl req -new -key "$work/key.pem" -out "$work/csr.pem" -subj "/CN=Storefront Code build/O=Storefront/C=BE"
	mise exec node@26.13.1 -- node fork/scripts/asc.mjs certificate "$type" "$work/csr.pem" "$work/cert.cer"
	openssl x509 -inform DER -in "$work/cert.cer" -out "$work/cert.pem"
	p12_password=$(openssl rand -hex 16)
	openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" \
		-passout "pass:$p12_password"
	security import "$work/identity.p12" -k "$KEYCHAIN" -P "$p12_password" \
		-T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild
	rm -rf "$work"
	trap - EXIT
	echo "imported $label"
done

# Let codesign use the keys without a GUI prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASSWORD" "$KEYCHAIN" >/dev/null
security find-identity -v -p codesigning "$KEYCHAIN"
