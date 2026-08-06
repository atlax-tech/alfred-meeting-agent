#!/bin/sh

set -eu

sign_identity="${INVIEW_SIGN_IDENTITY:-InviewPractice Build Signing}"

# Screen Recording permission is associated with the app's designated
# requirement. A fixed signing identity keeps that requirement stable between
# local builds; an ad-hoc signature would bind it to a build-specific CDHash.
check_signing_identity() {
  if /usr/bin/security find-identity -v -p codesigning |
    /usr/bin/grep -F "\"$sign_identity\"" >/dev/null; then
    return
  fi

  echo "Code-signing identity is not visible to this process: $sign_identity" >&2
  echo "Refusing to build or fall back to an ad-hoc signature because that would invalidate macOS privacy permissions." >&2
  echo "When running inside Codex, request elevated execution for 'npm run pack:mac'; a sandbox may falsely report '0 valid identities found'." >&2
  echo "Do not recreate or modify the certificate based only on the sandbox result." >&2
  exit 1
}

check_signing_identity

if [ "${1:-}" = "--check" ]; then
  exit 0
fi

app_path="${1:-release/mac-arm64/Alfred AI.app}"

if [ ! -d "$app_path" ]; then
  echo "App bundle not found: $app_path" >&2
  exit 1
fi

/usr/bin/codesign \
  --force \
  --deep \
  --sign "$sign_identity" \
  --identifier com.atlax.inview-practice \
  --timestamp=none \
  "$app_path"

/usr/bin/codesign --verify --deep --strict "$app_path"
/usr/bin/codesign -d -r- "$app_path"
