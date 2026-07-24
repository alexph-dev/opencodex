#!/usr/bin/env bash
set -euo pipefail

# Assembles OpenCodex.app by hand.
#
# No Xcode project, so there is nothing to keep in sync with the package manifest. The
# bundle is staged in a temp directory and moved into place at the end, so an interrupted
# build never leaves a half-written .app that launches and misbehaves.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_dir="$repo_root/app"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
configuration="${CONFIGURATION:-release}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build:macos requires macOS." >&2
  exit 1
fi

mkdir -p "$output_root"
output_root="$(cd "$output_root" && pwd)"
app_bundle="$output_root/OpenCodex.app"

# Refuse to write outside the intended output root.
case "$app_bundle" in
  "$output_root"/*.app) ;;
  *)
    echo "Refusing to replace unexpected bundle path: $app_bundle" >&2
    exit 1
    ;;
esac

swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexMenuBar)

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools ships only" >&2
    echo "current-architecture Swift compatibility libraries, so the x86_64 slice cannot" >&2
    echo "link. Install Xcode, then:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
fi

echo "==> Building ($configuration)…"
swift build "${swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"
executable="$bin_dir/OpenCodexMenuBar"

if [[ ! -x "$executable" ]]; then
  echo "Build did not produce an executable at $executable" >&2
  exit 1
fi

staging_root="$(mktemp -d "$output_root/.OpenCodex-build.XXXXXX")"
staged_app="$staging_root/OpenCodex.app"
iconset="$staging_root/OpenCodex.iconset"
cleanup() { rm -rf "$staging_root"; }
trap cleanup EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$executable" "$staged_app/Contents/MacOS/OpenCodexMenuBar"
cp "$package_dir/Info.plist" "$staged_app/Contents/Info.plist"

# The app version comes from package.json, so it can never claim a version the release
# did not ship.
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Could not read a valid version from package.json: '$version'" >&2
  exit 1
fi
plutil -replace CFBundleShortVersionString -string "$version" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$version" "$staged_app/Contents/Info.plist"

# Icon: reuse the dashboard favicon rather than adding another binary asset to the repo.
icon_source="$repo_root/gui/public/favicon.png"
if [[ ! -f "$icon_source" ]]; then
  echo "Missing icon source: $icon_source" >&2
  exit 1
fi
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_source" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$icon_source" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/OpenCodex.icns"

# Ad-hoc signature so Gatekeeper has a stable identity. CI may re-sign with a real one.
codesign --force --sign - --timestamp=none "$staged_app"

rm -rf "$app_bundle"
mv "$staged_app" "$app_bundle"

echo "==> Built $app_bundle (version $version)"
lipo -archs "$app_bundle/Contents/MacOS/OpenCodexMenuBar"
