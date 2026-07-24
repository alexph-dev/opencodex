# 020 — Phase 2: menu bar surface and popover UI

**Depends on:** `010` (client + models + formatting must exist).
**Independently verifiable by:** a screenshot of the running app read back with
`view_image`, plus state-coverage tests.

**No `.app` bundle in this phase.** Visual QA runs the Swift executable directly
(`swift run --package-path app OpenCodexMenuBar`), which registers a menu bar item and
opens the popover exactly like a bundled build. `scripts/build-macos-app.sh` and the first
`.app` are Phase-4 deliverables; an earlier draft moved the "first launchable bundle" here
without moving the builder that produces it.

Implements the locked direction in `003`. Dials: `DESIGN_VARIANCE 2`,
`MOTION_INTENSITY 1`, density `D7`.

## File change map

| Path | Action |
| --- | --- |
| `app/Sources/MenuBarApp/main.swift` | MODIFY — replace the 010 placeholder |
| `app/Sources/MenuBarApp/AppDelegate.swift` | NEW |
| `app/Sources/MenuBarApp/StatusItemController.swift` | NEW |
| `app/Sources/MenuBarApp/StatusIcon.swift` | NEW |
| `app/Sources/MenuBarApp/PopoverViewController.swift` | NEW |
| `app/Sources/MenuBarApp/Views/StatusHeaderView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/MetricsRowView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/SparklineView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/QuotaRowView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/ActionBarView.swift` | NEW |
| `app/Sources/MenuBarApp/Theme.swift` | NEW |
| `app/Sources/MenuBarCore/ProxySnapshot.swift` | NEW |
| `app/Sources/MenuBarCore/PollingCoordinator.swift` | NEW |
| `app/Tests/MenuBarCoreTests/SnapshotStateTests.swift` | NEW |

**AppKit, not SwiftUI.** SwiftUI in an `NSPopover` still fights sizing and first-responder
behaviour, and this layout is a fixed-width column of rows — precisely what AppKit stack
views do without ceremony. Zero-dependency and predictable beats idiomatic-but-fussy for
a surface that must render identically every time.

## `Theme.swift` — token derivation from `gui/src/styles.css`

`003` §1 established that the dashboard tokens are inherited rather than reinvented.
Where AppKit provides a semantic colour that already tracks the OS appearance, it wins
over a hardcoded hex, because it also handles increased-contrast and vibrancy.

```swift
enum Theme {
    // Surfaces: AppKit semantics track light/dark AND accessibility settings.
    static let background   = NSColor.windowBackgroundColor
    static let raised       = NSColor.controlBackgroundColor
    static let separator    = NSColor.separatorColor

    // Text: mapped from --text / --muted / --faint.
    static let text         = NSColor.labelColor
    static let muted        = NSColor.secondaryLabelColor
    static let faint        = NSColor.tertiaryLabelColor

    // State colours: taken verbatim from styles.css so the companion and the
    // dashboard agree on what "healthy" looks like.
    static let green = NSColor(light: 0x0A7D5C, dark: 0x4ECB9D)
    static let amber = NSColor(light: 0x9A4A08, dark: 0xFBBF24)
    static let red   = NSColor(light: 0xB91C1C, dark: 0xF87171)

    // Type ladder: --text-micro/caption/label/control.
    static let micro   = NSFont.systemFont(ofSize: 10, weight: .medium)
    static let caption = NSFont.systemFont(ofSize: 11)
    static let label   = NSFont.systemFont(ofSize: 12, weight: .semibold)
    static let numeric = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)

    static let gutter: CGFloat = 12   // --space-3
    static let rowGap: CGFloat = 8    // --space-2
    static let radius: CGFloat = 8    // --radius-sm
    static let width:  CGFloat = 340
}
```

`monospacedDigitSystemFont` is the AppKit equivalent of `font-variant-numeric:
tabular-nums` and is required by `003` §7 — without it, polling makes digits jitter.

`NSColor(light:dark:)` is a small `init(name:dynamicProvider:)` helper so state colours
follow the OS appearance the same way `light-dark()` does on the web.

## `ProxySnapshot.swift` — the state machine

One value type describes everything the UI can show, so every view is a pure function of
it and no view invents its own loading flag.

```swift
public enum ProxyState: Equatable, Sendable {
    case loading                        // first fetch in flight, nothing known yet
    case running(StartupHealth)
    case unreachable                    // connection refused → not running
    case unauthorized                   // 401 → needs an API key
    case degraded(String)               // reachable but errored; message is proxy-free text
}

public struct ProxySnapshot: Equatable, Sendable {
    public var state: ProxyState = .loading
    public var endpoint: ProxyEndpoint
    public var usage: UsageReport?
    public var quotas: [NormalizedQuota] = []
    public var providers: [ProviderSummary] = []
    public var lastUpdated: Date?
    public var consecutiveFailures: Int = 0
}
```

`003` §6 forbids fake data, so `usage` stays `nil` until it actually arrives; the metrics
row renders em dashes rather than zeros in the meantime.

## `PollingCoordinator.swift` — implements `002` §6

```swift
public actor PollingCoordinator {
    // 5s liveness always; 60s heavy data only while the popover is open.
    private static let livenessInterval: TimeInterval = 5
    private static let heavyInterval: TimeInterval = 60
    private static let backoffInterval: TimeInterval = 30   // after 3 consecutive failures

    public func setPopoverOpen(_ open: Bool)
    public func refreshNow() async
    public var snapshots: AsyncStream<ProxySnapshot> { get }
}
```

Heavy endpoints (`/api/usage`, `/api/provider-quotas`) are skipped entirely while the
popover is closed, and `/api/providers` is fetched only on open. After three consecutive
failures the liveness tick backs off to 30 s so a stopped proxy does not get hammered.
A menu bar app that polls a local server every 5 s forever is a battery complaint waiting
to happen.

## `StatusIcon.swift` — the signature moment (`003` §5)

```swift
enum StatusGlyph {
    static func image(for state: ProxyState) -> NSImage {
        let image: NSImage
        switch state {
        case .running(let h) where h.status == "protected": image = solidMark()
        case .running:                                      image = solidMarkNotched()
        case .loading, .degraded:                           image = outlinedMark()
        case .unreachable, .unauthorized:                   image = outlinedMark(alpha: 0.4)
        }
        image.isTemplate = true      // macOS inverts for light/dark menu bar
        return image
    }
}
```

Drawn as `NSImage(size:flipped:drawingHandler:)` vector paths at 18×18pt — no PNG assets
for the menu bar, so it stays crisp on every scale factor and inverts correctly as a
template image. No colour in the menu bar, per `003` §5.

## `PopoverViewController.swift` — layout

`NSStackView`, vertical, 340pt wide, `edgeInsets` of 12pt, spacing 8pt. Children in
urgency order per `003` §4:

1. `StatusHeaderView`
2. separator
3. `MetricsRowView` + `SparklineView`
4. separator
5. `QuotaRowView` per provider
6. separator
7. `ActionBarView`

Behaviour: `NSPopover.behavior = .transient` (click-away dismiss), `Escape` closes,
`animates = false` when reduce-motion is set.

### `StatusHeaderView`

```text
● Running          127.0.0.1:10100
  protected · service
```

Dot 8pt, `Theme.green/amber/red` by state, **always accompanied by the word** ("Running",
"Stopped", "Unreachable", "Needs API key") so meaning is never colour-only (`003` §8).
Endpoint right-aligned in `Theme.caption`/`muted`. Qualifier line renders
`health.protection` and `health.status`, and when `recommendedCommand` is present it is
shown as selectable text — displayed, never executed (`002` §3).

### `MetricsRowView`

Three columns from `/api/usage?range=7d`: REQUESTS, TOKENS, COST. Labels in
`Theme.micro` uppercase with 0.5pt tracking; values in `Theme.numeric`. All values
through `Format` (`010`), so `36536664705` becomes `36.5B` and `nil` becomes `—`.

**The range label is rendered from the response, not the request.** `002` §3 records that
`parseRange` silently falls back to `30d` for any unrecognized value, so a UI that
labelled its own request would lie whenever the server disagreed. The section header
reads `LAST 7 DAYS` only when `response.range == "7d"`.

When `summary.estimatedRequests > 0`, the requests value carries a trailing `~` with an
`accessibilityLabel` explaining the estimate — `003` §6 requires estimates to be marked.

### `SparklineView`

**Usage trend, not "activity".** One bar per element of `usage.days`, which is
day-granular — `002` §3 records that `rangeWindow()` only ever produces daily buckets and
that hourly data does not exist without a `src/` change. With `range=7d` that is 7 bars.
The bar count follows `days.count`; it is never hardcoded.

Pure `NSBezierPath` fill in `Theme.faint`, 24pt tall, no axes, no labels, no gradient.
Renders nothing (not a flat line) when data is absent.

Recent per-request activity (`GET /api/logs?tail=N`) is deliberately out of scope for v1 —
`002` §3 records the reasoning: per-request rows expose model and timing detail for the
user's real traffic, and the dashboard already presents it with proper filtering.

### `QuotaRowView`

```text
OpenAI          ▓▓▓▓▓░░░░░  44%
```

Provider label left, bar centre, percent right in `Theme.numeric`. Bar fill: `green` below
80, `amber` 80-95, `red` above 95. The percentage text is always present, so the colour is
redundant rather than load-bearing. `accessibilityValue` reads
`"44 percent of weekly quota, resets in 3d 4h"` from `NormalizedQuota` (`010`), which
already resolved the seconds/milliseconds trap.

Rows with `percent == nil` render the label and an em dash — never a zero-width bar that
looks like "0% used".

### `ActionBarView`

`Dashboard` (opens `http://127.0.0.1:<port>` in the browser) · `Stop proxy` (wired in `030`)
· `···` overflow menu (Preferences, Quit). Buttons are `.recessed` bezel, 24pt tall, with
`accessibilityLabel` on the icon-only overflow.

## State coverage (UX-STATE-01 — all four required)

| State | Header | Body | Action |
| --- | --- | --- | --- |
| `loading` | "Checking…" neutral dot | skeleton rows, em dashes | none |
| `running` | "Running" + green | live metrics, usage trend, quotas | Dashboard · Stop proxy |
| `unreachable` | "Stopped" + red | "The proxy is not running." | start command as selectable text |
| `unauthorized` | "Needs API key" + amber | "This proxy requires a key." | **Add key…** |
| `degraded` | "Degraded" + amber | last known values + staleness age | Retry |

Corrections from the Phase-0 audit, carried in from `030`:

- The `running` action is **`Stop proxy`**, never `Restart`. `/api/stop` stops launchd on
  purpose and no start endpoint exists.
- The `unreachable` action is **not** a button that starts anything. It displays the
  command to run (`ocx start`, or `ocx service start` when a service is installed) as
  selectable text, since the app never spawns processes.

### Empty states (per-section, distinct from `loading`)

`loading` means "not known yet" and correctly offers no action. **Empty means "known, and
there is nothing"** — a different fact needing different copy. Each data section defines
its own:

| Section | Empty condition | Copy | Action |
| --- | --- | --- | --- |
| Metrics | `summary` present, `requests == 0` | "No requests in the last 7 days." | Dashboard |
| Usage trend | `days` empty or all-zero | bars omitted entirely, no flat line | none |
| Quotas | `reports` empty | "No provider quota sources connected." | Dashboard |
| Providers | `providers` empty | "No providers configured." | Dashboard |

A zero is rendered as `0` only when the server actually reported zero; unknown stays an em
dash (`003` §6). Conflating the two is the fake-data tell.

Every non-running state names its next action — `dev-uiux-design` UX-STATE-01 forbids
dead-ending the user. `degraded` deliberately keeps the last known values with an explicit
"as of 2m ago" rather than blanking the popover, since stale-but-labelled beats empty.

## Tests (`SnapshotStateTests`)

`ProxyError.unreachable` → `.unreachable` · `401` → `.unauthorized` · `500` →
`.degraded` · health with `status: "protected"` → `.running` and solid glyph ·
unknown status string → `.running` with notched glyph, no crash · three failures raise
`consecutiveFailures` and trigger backoff · reduce-motion disables animation.

## Visual verification (mandatory before this phase closes)

Build, launch, open the popover, `screencapture` the region, read it back with
`view_image`, and check against `003` §6: no emoji, no gradient, no oversized type, no
colour-only meaning, numbers abbreviated and tabular, dark and light both legible. Fix
what the screenshot shows, then re-verify. Code review alone does not close this phase.

## Accept criteria

1. Menu bar icon renders as a template image and changes with state.
2. Popover renders live data from the running proxy at 340pt.
3. All five states reachable; each except `loading` names a next action.
4. Screenshot inspected with `view_image` in both appearances.
5. Keyboard: popover opens, Tab reaches every control, Escape closes.
6. The metrics header renders the range the response returned, verified by forcing a
   fallback (`?range=bogus` → server answers `30d` → header must read `LAST 30 DAYS`).
   The `UsageRange` enum is closed, so production code cannot issue `?range=bogus`; the
   test injects a stubbed response whose `range` differs from the requested value and
   asserts the header follows the response. A direct `curl ?range=bogus` is kept only as
   server-contract evidence in `002`.
7. Sparkline bar count equals `days.count`, not a hardcoded 24.
8. Each empty state above renders its defined copy, distinct from `loading`.
9. `swift run --package-path app OpenCodexMenuBar` shows the menu bar item and popover.
10. `swift test --package-path app` green.
