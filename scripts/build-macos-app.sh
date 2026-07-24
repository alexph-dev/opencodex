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

# The build deletes whatever sits at $app_bundle, so the destination must be somewhere
# this project owns. Comparing $app_bundle against $output_root proves nothing — both
# come from the same variable, so pointing OUTPUT_DIR at /Applications would have passed
# and then recursively removed a real app.
allowed_root="$repo_root"
if [[ -n "${TMPDIR:-}" ]]; then
  allowed_tmp="$(cd "${TMPDIR%/}" 2>/dev/null && pwd || echo "")"
else
  allowed_tmp=""
fi
case "$output_root" in
  "$allowed_root"/*) ;;
  /tmp/*|/private/tmp/*) ;;
  *)
    if [[ -z "$allowed_tmp" || "$output_root" != "$allowed_tmp"/* ]]; then
      echo "Refusing to build into '$output_root': it is outside the repository and the" >&2
      echo "temp directory. Set OUTPUT_DIR to a path under $repo_root." >&2
      exit 1
    fi
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

# CFBundleShortVersionString is the human-facing version and may carry a prerelease
# suffix. CFBundleVersion may NOT: Apple restricts it to period-separated integers, so
# writing "2.7.36-preview.1" there produces invalid metadata on every preview build.
# Strip to the numeric core, and let CI append a monotonic build number when it has one.
version_core="${version%%-*}"
build_version="$version_core"
if [[ -n "${MACOS_BUILD_NUMBER:-}" ]]; then
  if [[ ! "$MACOS_BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "MACOS_BUILD_NUMBER must be a positive integer, got '$MACOS_BUILD_NUMBER'" >&2
    exit 1
  fi
  build_version="$version_core.$MACOS_BUILD_NUMBER"
fi
if [[ ! "$build_version" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "Computed CFBundleVersion is not period-separated integers: '$build_version'" >&2
  exit 1
fi

plutil -replace CFBundleShortVersionString -string "$version" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$build_version" "$staged_app/Contents/Info.plist"

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

# Signing.
#
# MACOS_SIGN_IDENTITY selects a Developer ID Application certificate and enables the
# hardened runtime, which is what notarization requires. Without it the bundle is
# ad-hoc signed: structurally valid, but `spctl --assess` rejects it and a downloaded
# copy shows the "cannot be opened because the developer cannot be verified" dialog.
#
# The project has no Developer ID certificate today (that needs a paid Apple Developer
# account), so ad-hoc is the shipped default and the docs must tell users the
# right-click-Open path rather than pretend the download runs cleanly.
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$staged_app"
  echo "==> Signed with $MACOS_SIGN_IDENTITY (hardened runtime)"
else
  codesign --force --sign - --timestamp=none "$staged_app"
  echo "==> Ad-hoc signed (no MACOS_SIGN_IDENTITY): Gatekeeper will require the" >&2
  echo "    right-click-Open path on first launch." >&2
fi

rm -rf "$app_bundle"
mv "$staged_app" "$app_bundle"

echo "==> Built $app_bundle (version $version, build $build_version)"
lipo -archs "$app_bundle/Contents/MacOS/OpenCodexMenuBar"
