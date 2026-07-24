# 040 — Phase 4: universal build, release packaging, CI wiring

**Depends on:** `010`-`030` (there must be an app worth packaging).
**Independently verifiable by:** `lipo -archs` on the packaged executable, archive
content assertion, and workflow syntax validation.

This phase is the direct answer to the user's question — *"메뉴바는 못 넣는 거 아님? 앱을
만들어야 되는 거 아님?"* The app is only real when a user can download and run it without a
toolchain. Packaging architecture is inherited from PR #387 (`001` §5); it was the
strongest part of either PR and is not re-derived.

**Security note:** this phase edits `.github/workflows/release.yml`, which
`AGENTS.md` classifies as requiring explicit security review. Changes are therefore
minimal, additive, SHA-pinned, and least-privilege. No secret is introduced.

## File change map

| Path | Action |
| --- | --- |
| `scripts/build-macos-app.sh` | NEW |
| `scripts/package-macos-release.sh` | NEW |
| `package.json` | MODIFY — three script entries |
| `.github/workflows/ci.yml` | MODIFY — path filter + macOS steps |
| `.github/workflows/release.yml` | MODIFY — `package-macos` job + asset attach |
| `.gitignore` | MODIFY — `dist/macos/` (already added in `010`) |

## `scripts/build-macos-app.sh`

Assembles the bundle by hand. No Xcode project, so nothing to keep in sync.

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/app"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
configuration="${CONFIGURATION:-release}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "build:macos requires macOS." >&2; exit 1; }

# Refuse to write outside the intended output root (inherited from PR #387).
app_bundle="$output_root/OpenCodex.app"
case "$app_bundle" in "$output_root"/*.app) ;; *) echo "Refusing unexpected bundle path" >&2; exit 1;; esac

swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexMenuBar)
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools ships only" >&2
    echo "current-architecture Swift compatibility libraries." >&2
    echo "Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
fi

swift build "${swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"
```

**The CLT guard is not optional.** `001` §4.1 records the live probe on this machine:

```text
swift build --arch arm64 --arch x86_64 -c release
  -> ld: symbol(s) not found for architecture x86_64
swift build --arch arm64 -c release
  -> Build complete! (10.39 sec)
```

Without the guard, a contributor on Command Line Tools gets a linker error with no
explanation. PR #387 discovered this and its message is kept nearly verbatim.

Staging, then atomic swap:

```bash
staging_root="$(mktemp -d "$output_root/.OpenCodex-build.XXXXXX")"
staged_app="$staging_root/OpenCodex.app"
trap 'rm -rf "$staging_root"' EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$bin_dir/OpenCodexMenuBar" "$staged_app/Contents/MacOS/OpenCodexMenuBar"

# Version comes from package.json — the app can never claim a version the release did not ship.
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
plutil -replace CFBundleShortVersionString -string "$version" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$version" "$staged_app/Contents/Info.plist"

# Icon: reuse the existing dashboard favicon, no new binary asset in the repo.
iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/OpenCodex.icns"

# Ad-hoc sign so Gatekeeper has a stable identity; CI may re-sign with a real identity.
codesign --force --sign - --timestamp=none "$staged_app"

rm -rf "$app_bundle" && mv "$staged_app" "$app_bundle"
```

Building into a temp dir and moving at the end means an interrupted build never leaves a
half-written `.app` that launches and misbehaves.

## `scripts/package-macos-release.sh`

Wraps the bundle for distribution. Every step is an assertion, not a hope.

```bash
RELEASE_VERSION guard   # package.json must equal the requested release version
UNIVERSAL=1 CONFIGURATION=release bash scripts/build-macos-app.sh
codesign --verify --deep --strict --verbose=2 "$app_bundle"
lipo -archs "$executable"                 # must contain arm64 AND x86_64 when UNIVERSAL=1
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$archive_path"
unzip -Z1 "$archive_path" | grep -Fqx 'OpenCodex.app/Contents/MacOS/OpenCodexMenuBar'
shasum -a 256 "$archive_name" > "$checksum_name"
```

Output: `OpenCodex-<version>-macos-universal.zip` + `.sha256`.

`ditto` rather than `zip`: it preserves extended attributes and symlinks, so the unpacked
bundle stays launchable. Plain `zip` corrupts code signatures. The `unzip -Z1` assertion
catches the case where the archive is produced but empty.

## `package.json`

```json
"build:macos":   "bash scripts/build-macos-app.sh",
"package:macos": "bash scripts/package-macos-release.sh",
"test:macos":    "swift test --package-path app"
```

## `.github/workflows/ci.yml`

Path filter gains `"app/**"` in both the `pull_request` and `push` blocks. New steps in
the existing cross-platform job, gated so Linux and Windows runners skip them:

```yaml
- name: Test macOS menu bar app
  if: runner.os == 'macOS'
  run: bun run test:macos

- name: Build macOS menu bar app
  if: runner.os == 'macOS'
  run: bun run build:macos
```

Placed after `privacy:scan` so a credential leak fails before a long Swift build runs.

## `.github/workflows/release.yml`

New job, mirroring #387's shape:

```yaml
package-macos:
  runs-on: macos-latest
  timeout-minutes: 15
  outputs:
    archive_name:  ${{ steps.package.outputs.archive_name }}
    checksum_name: ${{ steps.package.outputs.checksum_name }}
  steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
    - id: package
      env:
        RELEASE_VERSION: ${{ inputs.version }}
        UNIVERSAL: "1"
      run: bash scripts/package-macos-release.sh
    - uses: actions/upload-artifact@<pinned-sha>
```

The release job then downloads the artifact and attaches both files to the GitHub
Release. **`UNIVERSAL: "1"` is safe here specifically because `macos-latest` carries a
full Xcode**, which is the environment `001` §4.1 identified as the one that can produce
both slices. This is why the universal assertion lives in CI and not in the local gate.

Constraints honoured:

- Every action pinned to a full commit SHA (existing repo convention, and `AGENTS.md`
  treats mutable third-party refs as a release blocker).
- `package-macos` needs no `id-token`, no `contents: write`, no secrets.
- The npm publish path is untouched; a macOS packaging failure must not be able to
  corrupt an npm release.

## Privacy and artifact hygiene

`bun run privacy:scan` must pass. Concretely:

- `app/.gitignore` excludes `.build/`, `.swiftpm/`, `DerivedData/` (landed in `010`).
- Root `.gitignore` excludes `dist/macos/`.
- `git ls-files app/ | grep -E '\.build/|DerivedData/'` must return empty.
- No absolute developer path appears in any committed file — this is the exact defect
  that blocked PR #421 (`001` §2), and it is checked explicitly rather than assumed.

## Accept criteria

1. `bun run build:macos` produces a launchable `dist/macos/OpenCodex.app`.
2. `bun run package:macos` produces zip + `.sha256`, with the content assertion passing.
3. `lipo -archs` shows `arm64` locally; both arches asserted in CI.
4. `UNIVERSAL=1` under Command Line Tools fails with the explanatory message, not a
   linker error.
5. Workflow YAML parses; all actions SHA-pinned.
6. `bun run typecheck`, `bun run test`, `bun run privacy:scan` green.
7. No build artifacts tracked by git.
