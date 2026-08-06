#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
release_dir="$project_dir/release"
app_path="$release_dir/mac-arm64/InviewPractice.app"
version=$(cd "$project_dir" && node -p "require('./package.json').version")
archive_path="$release_dir/InviewPractice-$version-mac-arm64.zip"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
verify_dir=''

cleanup() {
  if [ -n "$verify_dir" ] && [ -d "$verify_dir" ]; then
    /bin/rm -rf "$verify_dir"
  fi
}

trap cleanup EXIT HUP INT TERM

cd "$project_dir"

sh scripts/sign-mac.sh --check
sh scripts/build-mouse-idle.sh
sh scripts/build-vision-ocr.sh
sh scripts/build-liquid-glass.sh
./node_modules/.bin/electron-vite build
./node_modules/.bin/electron-builder --mac --dir
sh scripts/sign-mac.sh "$app_path"

if [ ! -d "$app_path" ]; then
  echo "Signed app bundle not found: $app_path" >&2
  exit 1
fi

/bin/rm -f "$archive_path"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive_path"
/usr/bin/unzip -tq "$archive_path"

verify_dir=$(/usr/bin/mktemp -d /private/tmp/inview-package-verify.XXXXXX)
/usr/bin/ditto -x -k "$archive_path" "$verify_dir"
/usr/bin/codesign --verify --deep --strict "$verify_dir/InviewPractice.app"

archive_bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$verify_dir/InviewPractice.app/Contents/Info.plist")
archive_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$verify_dir/InviewPractice.app/Contents/Info.plist")

if [ "$archive_bundle_id" != 'com.atlax.inview-practice' ]; then
  echo "Unexpected bundle identifier in archive: $archive_bundle_id" >&2
  exit 1
fi

if [ "$archive_version" != "$version" ]; then
  echo "Unexpected app version in archive: $archive_version (expected $version)" >&2
  exit 1
fi

# Keep only the newly verified installer. Older installers are removed only
# after the replacement archive has passed integrity, signature, bundle ID,
# and version checks.
/usr/bin/find "$release_dir" -maxdepth 1 -type f \
  -name 'InviewPractice-*-mac-arm64.zip' ! -path "$archive_path" \
  -exec /bin/rm -f -- {} +

if [ -x "$lsregister" ]; then
  "$lsregister" -u "$app_path" >/dev/null 2>&1 || true
fi

# The signed app is an intermediate staging bundle. Keeping it would make
# Finder and LaunchServices discover a second runnable copy next to the one
# installed in /Applications. The verified ZIP is the durable build artifact.
/bin/rm -rf "$app_path"
/bin/rmdir "$release_dir/mac-arm64" 2>/dev/null || true

echo "Created and verified: $archive_path"
echo "Removed staging app: $app_path"
