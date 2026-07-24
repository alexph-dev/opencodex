# 001 — Survey: PR #387 vs PR #421, and the stack decision

Research document. No diffs here (LEXICO-SPLIT-01); implementation lives in the decade docs.

## 1. PR #387 — `feat: ship packaged macOS menu bar companion` (jaycho46)

**Branch:** `feat/menubar-app` · **Directory:** `apps/macos-menu-bar/` · 16 commits · +1656/-32

Architecture (read from the branch, not from the PR body):

```text
Package.swift            swift-tools-version 5.9, .macOS(.v12)
  OpenCodexMenuBarCore   OcxClient, OcxLocator, StatusModels     (library, tested)
  OpenCodexMenuBar       main.swift, MenuText, StatusBarIcon      (executable)
  Tests                  OpenCodexMenuBarCoreTests
```

**Transport: `ocx` CLI subprocess.** `OcxClient.fetchStatus` locates the `ocx`
executable via `OcxLocator`, runs `ocx status --json`, then brace-slices the stdout
(`output.firstIndex(of: "{")` … `lastIndex(of: "}")`) and decodes it. Write actions run
through `commandPlan(for:status:)`, which emits further `ocx` argument vectors.

To make that transport work, the PR also **extends `src/cli/status.ts`** with
`proxy.health.version` and `proxy.health.uptimeSeconds`, and adds
`tests/cli-status-json.test.ts`.

Packaging (the genuinely strong part):

- `scripts/build-macos-app.sh` — assembles `OpenCodex.app` by hand: `Contents/MacOS`,
  `Contents/Resources`, `Info.plist`, an `.iconset` built from `gui/public/favicon.png`,
  and a refusal guard on unexpected bundle paths.
- `scripts/package-macos-release.sh` — `codesign --verify --deep --strict`,
  `lipo -archs` assertion for both arches, `ditto -c -k --sequesterRsrc --keepParent`,
  archive content assertion (`unzip -Z1` must contain the executable), `shasum -a 256`.
- `.github/workflows/release.yml` — new `package-macos` job on `macos-latest`, artifact
  upload, and Release asset attachment. Also scopes Trusted Publishing OIDC to the
  publish job (commit `fbc9c844`), which is an unrelated but correct hardening.
- `.github/workflows/ci.yml` — `test:macos` and `build:macos` steps gated on
  `runner.os == 'macOS'`.

Review history: no maintainer review. Its own author left 10 self-review comments and
CodeRabbit iterated ~14 rounds; the commit tail (`1454a925` bound CLI runs with a
timeout and concurrent pipe drain, `dcf4fea0` treated stale launchd services as
repairable, `0ebbb6a7` waited for pipe drain before reading buffers) shows real defect
repair, not cosmetic churn.

## 2. PR #421 — `feat(menubar): redesign as macOS status widget` (genglintong)

**Branch:** `feat/menubar-status-widget` · **Directory:** `menubar/` · 5 commits · +14532/-0

Architecture:

```text
menubar/src-tauri/     Rust: tray.rs, keychain.rs, discover.rs, api.rs  (~170 lines)
menubar/src/           React 19 + TS: App, sections/{Usage,Health,Status,Setup,Activity}
menubar/scripts/       build-app.sh, check-version.sh
```

**Transport: HTTP management API.** `discover.rs` reads
`~/.opencodex/runtime-port.json`; `api.rs` proxies WebView `invoke("api_request")` calls
through Rust `reqwest` so the API token stays out of JS memory, sourced from the macOS
Keychain. Zero proxy-side changes — it consumes only endpoints that already exist.

Design: four-tab segmented widget (Usage / Health / Status / Activity), Apple-style
white theme, tabular-nums stats, `macOSPrivateApi: true` for a transparent rounded
popover with shadow. The submitted screenshot is the more polished of the two.

Distribution: **none.** `.github/` is untouched — no CI job, no release job. Its own
Non-goals list says "DMG / Homebrew distribution (cargo build from source)". A user
would need `rustup` plus a full frontend toolchain to obtain the app.

Blocking defect: `menubar/src-tauri/target/**` was committed. The Codex reviewer's P1
notes that `.rustc_info.json` and sibling artifacts embed the contributor's
`/Users/glt/` home path and that `bun run privacy:scan` fails on the tree. Adding the
path to `.gitignore` does not remove it from history.

## 3. Head-to-head

| Axis | #387 (Swift) | #421 (Tauri) |
| --- | --- | --- |
| Runtime deps to build | Swift toolchain (Xcode CLT) | Rust + Node + Tauri CLI |
| Runtime deps to run | none (native binary) | none (bundled WebView) |
| Bundle size class | ~single-MB native | tens of MB (WebView shell + Rust) |
| Transport | `ocx` CLI subprocess | HTTP management API |
| Requires proxy source change | yes (`src/cli/status.ts`) | no |
| Distribution to users | zip + SHA-256 attached to Release | none, build from source |
| CI coverage | macOS test + build steps | none |
| Committed artifacts | none | `src-tauri/target/**` (privacy:scan FAIL) |
| UI polish (as submitted) | functional menu | higher — segmented tabs, tuned spacing |
| Data breadth | proxy status + control | usage, health, status, activity, quotas |

## 4. Stack decision — Swift + AppKit, transport over HTTP

**Decision: build in Swift (SwiftPM + AppKit), and talk to the proxy over the HTTP
management API.** This is a hybrid: #387's runtime and packaging discipline, #421's
transport and information architecture.

Rationale, in order of weight:

1. **Distribution is the whole point of the user's question.** A menu bar app that the
   user must compile is not a shipped app. #387 already proves the packaging path end to
   end; #421 explicitly declines it. Rebuilding Tauri packaging from scratch would mean
   re-deriving what #387 already verified.
2. **HTTP beats CLI subprocess for a polling UI.** Spawning `ocx` every refresh cycle
   costs a process launch plus Bun startup per tick, requires the brace-slicing hack to
   survive incidental stdout, and — decisively — needs `src/cli/status.ts` to grow new
   fields. The user put `src/` out of scope. The management API already returns richer
   data (`/api/usage`, `/api/provider-quotas`) with no proxy change at all.
3. **Dependency weight.** Swift + AppKit ships zero third-party dependencies. Tauri adds
   a Rust toolchain, a Cargo lockfile, generated ACL schemas, and a WebView runtime to a
   repository whose entire premise is a single Bun process.
4. **`macOSPrivateApi: true` is a liability.** #421 enables it for rounded corners.
   Private API usage is a documented App Store rejection vector and a notarization risk;
   AppKit's `NSPopover` gives the same visual result through public API.

### 4.1 The universal-binary finding (must be honoured by Phase 4)

Probed live on this machine:

```text
swift build --arch arm64 --arch x86_64 -c release
  -> ld: symbol(s) not found for architecture x86_64
swift build --arch arm64 -c release
  -> Build complete! (10.39 sec)
```

Command Line Tools ships only current-architecture Swift compatibility libraries, and
macOS 27 additionally deprecates x86_64 for this deployment target. #387's build script
already detects this and refuses `UNIVERSAL=1` under CLT with a clear message — that
guard is correct and is inherited.

**Consequence for the plan:** local verification is arm64-only and that is expected, not
a failure. The universal assertion belongs in CI, where `macos-latest` runners carry a
full Xcode. Phase 4 must therefore keep `UNIVERSAL` opt-in with the CLT guard, and the
`lipo` both-arch assertion must run in the CI job rather than gating local builds.

## 5. What is salvaged from each PR

From **#387 (jaycho46)** — packaging architecture: manual bundle assembly, the
unexpected-bundle-path refusal guard, `codesign --verify --deep --strict`, `lipo`
assertion, `ditto` archiving with archive-content verification, SHA-256 sidecar, the
`package-macos` release job shape, the CLT/universal guard, and the Gatekeeper
first-launch documentation angle.

From **#421 (genglintong)** — product architecture: HTTP management-API transport,
`runtime-port.json` discovery with a 10100 fallback, auth token held outside the
rendering layer, the four-surface information architecture (usage / health / status /
activity), tabular-numeral stat treatment, and skipping auth entirely when the proxy has
no `apiKeys` configured.

## 6. Rejected alternatives

- **Merge #387, then re-skin later.** Rejected: it lands the `src/cli/status.ts` change
  the user excluded, and the CLI transport would have to be replaced anyway.
- **Merge #421, then add packaging.** Rejected: the committed `target/` tree fails
  `privacy:scan` and would need history rewriting, and the private-API dependency stays.
- **Ask the contributors to converge.** Rejected: the user asked for the maintainer
  version now; a two-way contributor negotiation is slower and leaves both PRs open.
