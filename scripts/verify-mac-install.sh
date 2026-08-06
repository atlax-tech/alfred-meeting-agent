#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
version=$(cd "$project_dir" && node -p "require('./package.json').version")
install_path='/Applications/Alfred AI.app'
staging_path="$project_dir/release/mac-arm64/Alfred AI.app"
bundle_id=com.atlax.inview-practice

if [ ! -d "$install_path" ]; then
  echo "Installed app not found: $install_path" >&2
  exit 1
fi

installed_bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$install_path/Contents/Info.plist")
installed_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$install_path/Contents/Info.plist")

if [ "$installed_bundle_id" != "$bundle_id" ]; then
  echo "Unexpected installed bundle identifier: $installed_bundle_id" >&2
  exit 1
fi

if [ "$installed_version" != "$version" ]; then
  echo "Unexpected installed version: $installed_version (expected $version)" >&2
  exit 1
fi

/usr/bin/codesign --verify --deep --strict "$install_path"

if [ -d "$staging_path" ]; then
  echo "Staging app still exists: $staging_path" >&2
  exit 1
fi

user_name=${SUDO_USER:-$(/usr/bin/id -un)}
user_home=$(/usr/bin/dscl . -read "/Users/$user_name" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')

if [ -z "$user_home" ] || [ ! -d "$user_home" ]; then
  echo "Unable to resolve the current user's home directory." >&2
  exit 1
fi

candidate_paths=$(
  for search_root in \
    /Applications \
    "$user_home/Applications" \
    "$user_home/Desktop" \
    "$user_home/Downloads" \
    "$project_dir"
  do
    if [ -d "$search_root" ]; then
      /usr/bin/find "$search_root" -type d -name '*.app' -prune -print 2>/dev/null || true
    fi
  done

  /usr/bin/mdfind "kMDItemCFBundleIdentifier == '$bundle_id'" 2>/dev/null || true
)

matching_paths=$(
  printf '%s\n' "$candidate_paths" |
    /usr/bin/awk 'NF && !seen[$0]++' |
    while IFS= read -r candidate_path; do
      if [ ! -d "$candidate_path" ] || [ ! -f "$candidate_path/Contents/Info.plist" ]; then
        continue
      fi

      candidate_bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate_path/Contents/Info.plist" 2>/dev/null || true)
      if [ "$candidate_bundle_id" = "$bundle_id" ]; then
        printf '%s\n' "$candidate_path"
      fi
    done
)

matching_count=$(printf '%s\n' "$matching_paths" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')

if [ "$matching_count" -ne 1 ] || [ "$matching_paths" != "$install_path" ]; then
  echo "Expected exactly one installed app with bundle identifier $bundle_id." >&2
  echo "Found:" >&2
  printf '%s\n' "$matching_paths" >&2
  exit 1
fi

echo "Verified one runnable copy: $install_path (version $installed_version)"
