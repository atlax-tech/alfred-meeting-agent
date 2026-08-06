#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir="$project_dir/build/native"
napi_include="$project_dir/node_modules/node-addon-api/src"

mkdir -p "$output_dir"

/usr/bin/xcrun --sdk macosx clang++ \
  -std=c++17 \
  -fobjc-arc \
  -fvisibility=hidden \
  -mmacosx-version-min=13.0 \
  -I"$napi_include" \
  -framework AppKit \
  -bundle \
  -undefined dynamic_lookup \
  "$project_dir/native/liquid-glass.mm" \
  -o "$output_dir/liquid-glass.node"

chmod 755 "$output_dir/liquid-glass.node"
