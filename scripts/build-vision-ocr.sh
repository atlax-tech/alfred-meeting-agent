#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir="$project_dir/build/native"
module_cache="$output_dir/swift-module-cache"

mkdir -p "$output_dir" "$module_cache"

/usr/bin/xcrun --sdk macosx swiftc \
  -module-cache-path "$module_cache" \
  -framework AppKit \
  -framework Foundation \
  -framework ImageIO \
  -framework Vision \
  "$project_dir/native/vision-ocr.swift" \
  -o "$output_dir/vision-ocr"

chmod 755 "$output_dir/vision-ocr"
