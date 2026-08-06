#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
version=$(cd "$project_dir" && node -p "require('./package.json').version")
archive_path=${1:-"$project_dir/release/InviewPractice-$version-mac-arm64.zip"}
install_path=/Applications/InviewPractice.app
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
extract_dir=''
backup_dir=''
had_previous=0
rollback_required=0

validate_app() {
  candidate_path=$1
  expected_version=$2

  if [ ! -d "$candidate_path" ]; then
    echo "App bundle not found: $candidate_path" >&2
    return 1
  fi

  candidate_bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate_path/Contents/Info.plist")
  candidate_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate_path/Contents/Info.plist")

  if [ "$candidate_bundle_id" != 'com.atlax.inview-practice' ]; then
    echo "Unexpected bundle identifier: $candidate_bundle_id" >&2
    return 1
  fi

  if [ "$candidate_version" != "$expected_version" ]; then
    echo "Unexpected app version: $candidate_version (expected $expected_version)" >&2
    return 1
  fi

  /usr/bin/codesign --verify --deep --strict "$candidate_path"
}

cleanup() {
  if [ "$rollback_required" -eq 1 ]; then
    echo "Installation failed; restoring the previous app." >&2
    /bin/rm -rf "$install_path"
    if [ "$had_previous" -eq 1 ] && [ -d "$backup_dir/InviewPractice.app" ]; then
      /bin/mv "$backup_dir/InviewPractice.app" "$install_path"
    fi
  fi

  if [ -n "$extract_dir" ] && [ -d "$extract_dir" ]; then
    /bin/rm -rf "$extract_dir"
  fi

  if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
    /bin/rm -rf "$backup_dir"
  fi
}

trap cleanup EXIT HUP INT TERM

if [ ! -f "$archive_path" ]; then
  echo "Package archive not found: $archive_path" >&2
  echo "Run 'npm run pack:mac' first." >&2
  exit 1
fi

extract_dir=$(/usr/bin/mktemp -d /private/tmp/inview-install.XXXXXX)
backup_dir=$(/usr/bin/mktemp -d /private/tmp/inview-install-backup.XXXXXX)
/usr/bin/ditto -x -k "$archive_path" "$extract_dir"
source_app="$extract_dir/InviewPractice.app"
validate_app "$source_app" "$version"

if /usr/bin/pgrep -x InviewPractice >/dev/null 2>&1; then
  /usr/bin/pkill -TERM -x InviewPractice || true
  attempts=0
  while /usr/bin/pgrep -x InviewPractice >/dev/null 2>&1 && [ "$attempts" -lt 20 ]; do
    /bin/sleep 0.25
    attempts=$((attempts + 1))
  done

  if /usr/bin/pgrep -x InviewPractice >/dev/null 2>&1; then
    /usr/bin/pkill -KILL -x InviewPractice || true
  fi
fi

if [ -d "$install_path" ]; then
  had_previous=1
  if [ -x "$lsregister" ]; then
    "$lsregister" -u "$install_path" >/dev/null 2>&1 || true
  fi
  /bin/mv "$install_path" "$backup_dir/InviewPractice.app"
fi

rollback_required=1
/usr/bin/ditto "$source_app" "$install_path"
validate_app "$install_path" "$version"
/usr/bin/cmp "$source_app/Contents/MacOS/InviewPractice" "$install_path/Contents/MacOS/InviewPractice"
/usr/bin/cmp "$source_app/Contents/Resources/app.asar" "$install_path/Contents/Resources/app.asar"

if [ -x "$lsregister" ]; then
  "$lsregister" -f "$install_path" >/dev/null 2>&1 || true
fi

rollback_required=0
/bin/rm -rf "$backup_dir"
backup_dir=''

sh "$script_dir/verify-mac-install.sh"
echo "Installed and verified InviewPractice $version at $install_path"
