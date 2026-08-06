#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir="$project_dir/build/native"

mkdir -p "$output_dir"

/usr/bin/xcrun --sdk macosx clang \
  -framework CoreFoundation \
  -framework CoreGraphics \
  "$project_dir/native/mouse-idle.c" \
  -o "$output_dir/mouse-idle"

chmod 755 "$output_dir/mouse-idle"
