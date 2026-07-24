# 030 — Phase 3: write actions on existing endpoints

**Depends on:** `020` (the UI must exist to report a result into).
**Independently verifiable by:** a live stop and a live provider toggle against the
running proxy, with the observed response and the resulting UI state.

Constraint from the user's scope: **no new proxy endpoints.** Everything here calls
routes inventoried in `002` §4.

## Stale check at P (what Phase 2 already landed)

Re-verifying this document against the tree found three items already done, because the
UI phase could not ship a `Stop proxy` button without them:

- `ProxyClient.stop()` and `setProviderDisabled(_:disabled:)` exist (`010`/`020`).
- The confirmation sheet exists as an `NSAlert` in `AppDelegate.stopProxy()`, including
  the `isPresentingModal` guard that keeps the panel alive behind it.
- `ConfirmSheet.swift` is therefore not needed as a separate file.

What remained, and is what this phase delivers: an `ActionCoordinator` that reports what
actually happened, the provider toggle UI, and result feedback in the popover.

## File change map

| Path | Action |
| --- | --- |
| `app/Sources/MenuBarCore/ProxyClient.swift` | MODIFY — three-state liveness, decode the stop `success` flag |
| `app/Sources/MenuBarCore/ActionCoordinator.swift` | NEW |
| `app/Sources/MenuBarUI/ProviderListView.swift` | NEW — disclosure + toggles |
| `app/Sources/MenuBarUI/PopoverViewController.swift` | MODIFY — result banner, provider section |
| `app/Sources/MenuBarUI/AppDelegate.swift` | MODIFY — wire both actions to the coordinator |
| `app/Sources/MenuBarCoreTests/ActionSuite.swift` | NEW |

## `ProxyClient` additions

```swift
public func stop() async throws {
    var request = URLRequest(url: endpoint.baseURL.appendingPathComponent("api/stop"))
    request.httpMethod = "POST"
    request.timeoutInterval = 6
    if let key = apiKey { request.setValue(key, forHTTPHeaderField: "x-opencodex-api-key") }
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        throw ProxyError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
    }
}

public func setProviderDisabled(_ name: String, disabled: Bool) async throws {
    var components = URLComponents(url: endpoint.baseURL.appendingPathComponent("api/providers"),
                                   resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "name", value: name)]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(["disabled": disabled])
    ...
}
```

The PATCH body is exactly `{"disabled": <bool>}` and nothing else. `002` §4 records
`provider-routes.ts:239`: a `disabled`-only patch skips the heavy merged-shape
validators. Adding any second field would silently change the request class.

## `ActionCoordinator.swift`

### There is no restart. There is only stop.

This was the single biggest correction from the Phase-0 audit, and it is worth stating
plainly because an earlier draft of this document got it wrong.

`src/server/management-api.ts:136-147` — `/api/stop` calls `stopServiceIfInstalled()`
**before** responding. That call exists precisely so launchd cannot respawn the proxy.
So a service-managed proxy does not come back on its own, and there is no start endpoint
to call. A control labelled "Restart" would therefore be a lie in every configuration.

**Decision: the app ships `Stop proxy`, never `Restart`.** After a successful stop, the
UI enters the `unreachable` state (`020`) whose next action shows the exact command to
start it again (`ocx start`, or `ocx service start` when a service is installed) as
selectable text. The app does not spawn processes the user did not ask for, and it does
not claim a capability the API does not have.

This removes the `serviceManaged` computed branch an earlier draft assumed. The
`StartupHealth.serviceInstalled` / `serviceEnabled` fields are still decoded in `010` —
they render the status qualifier line in `020`, they just no longer gate an action.

### The drain problem

`002` §4 also records that `/api/stop` answers `200` **before** draining. Treating `200`
as "stopped" would make the UI lie for several seconds.

```swift
public enum ActionOutcome: Equatable, Sendable {
    case succeeded
    case failed(String)          // user-facing text, never a raw response body
    case requiresManualStart     // stop confirmed; the app cannot relaunch it
}

public func stopProxy() async -> ActionOutcome {
    do { try await client.stop() } catch { return .failed("Could not reach the proxy to stop it.") }

    // Poll until the port stops answering, up to 10s, before claiming anything.
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
        try? await Task.sleep(for: .milliseconds(500))
        if await !client.isReachable() { return .requiresManualStart }
    }
    return .failed("The proxy did not stop within 10 seconds.")
}
```

`requiresManualStart` is the honest success case: the stop is confirmed, and the app
says so while telling the user how to bring it back.

### Provider toggle — the default-provider trap

`002` §4 records `provider-routes.ts:178`: disabling `config.defaultProvider` returns
`400` with `"cannot disable the default provider; set another default first"`.

Per `dev-uiux-design` UX-LAZY-01, firing a request guaranteed to fail is not acceptable.
The toggle is disabled up front with an explanatory tooltip:

```swift
let isDefault = provider.name == config.defaultProvider
toggle.isEnabled = !isDefault
toggle.toolTip = isDefault
    ? "This is the default provider. Choose another default in the dashboard first."
    : nil
```

**`defaultProvider` comes from `GET /api/config`, not `/api/settings`.** The audit
verified the live `/api/settings` key set is exactly `codexAutoStart`, `port`,
`hostname`, `streamMode`, `startupHealth`, `codexRuntime` — no `defaultProvider`.
`/api/config` returns it (`"defaultProvider": "openai"` live). `010` adds a
`ProxyConfigSummary` model and `config()` client method for this.

Optimistic update with rollback: flip the switch immediately, send the PATCH, and revert
with an inline error on failure. Reverting is the required behaviour — leaving a switch
in a state the server rejected is the "fake state" tell.

## Confirmation policy

| Action | Confirmation | Why |
| --- | --- | --- |
| Stop proxy | **Yes** — sheet | Disruptive: kills in-flight requests, and nothing restarts it |
| Provider disable | No — optimistic + undo | Cheap and reversible |
| Provider enable | No | Strictly additive |

`dev-uiux-design` UX-LAZY-01 exempts destructive actions from magic defaults, and stopping
a proxy mid-request is destructive. Everything else stays frictionless.

`ConfirmSheet` states the concrete consequence — "In-flight requests will be interrupted,
and OpenCodex will not restart on its own." — not a generic "Are you sure?".

## Security rules

- Write requests carry the key in `x-opencodex-api-key`, read from the Keychain lazily
  (`010`), and never in a URL query.
- No response body ever reaches a log, an error string, or the UI verbatim. Failures map
  to a fixed set of human sentences.
- **No shell execution at all.** The app never spawns `ocx` or any other process; it only
  displays the command for the user to run. This is stricter than PR #387, which shelled
  out to the CLI, and it removes an entire class of injection and privilege concerns.
- The app never writes to `~/.opencodex/config.json` directly; all mutation goes through
  the management API so the proxy's own validation runs.

## Tests (`ActionTests`)

Stubbed `URLProtocol`:

- `stop()` on `200` → `.requiresManualStart` only after reachability actually drops.
- `stop()` where the port keeps answering → `.failed`, never a false success.
- `setProviderDisabled` sends `PATCH /api/providers?name=x` with body exactly
  `{"disabled":true}`.
- A `400` response reverts the optimistic toggle.
- The default provider (from `/api/config`) has its toggle disabled before any request is
  attempted.
- No code path constructs a `Process` / `NSTask`.
- No error path leaks a response body into `ActionOutcome`.

## Code-review corrections (folded before B closed)

| Finding | Correction |
| --- | --- |
| `isReachable()` treated every non-401 error as "gone", so a 500 or a decode failure during polling reported a stop as confirmed while an HTTP server was still listening | Three-state `liveness()`: `reachable` (any HTTP answer, including 401/403/500 and undecodable bodies), `refused` (the only proof), `indeterminate` (timeouts prove nothing) |
| `/api/stop` returns `success: false` when `restoreNativeCodex()` fails — the proxy still exits, but native Codex is left pointing at a closing port. The body was discarded and the app said "Proxy stopped" | Decode only the boolean, never the server's message. New `stoppedWithRestoreFailure` outcome tells the user to run `ocx restore` |
| Two rapid toggles could reach the server out of order, leaving it opposite to the user's last click | One in-flight write per provider in the coordinator, and the row goes inert until its authoritative refresh lands. Pending state survives `rebuildRows`, so a poll cannot resurrect the pre-toggle switch |
| A default provider that was already disabled could never be re-enabled: the switch was inert whenever `isDefault`. The proxy guard is `rawBody.disabled && name === defaultProvider` — only *disabling* is refused | The switch is inert only when it would disable an enabled default |
| The "exact body" test encoded its own dictionary and compared that, so it would pass with no request body at all | `StubProtocol` now drains `httpBodyStream` and the test asserts on the decoded actual body |
| An outcome test built non-empty literals and asserted they were non-empty | Replaced with one that drives three real failure paths and checks the user-visible message, including that no response body leaks |
| Acceptance criterion 1 demanded a live stop while the notes said stop was deliberately not run live | Criterion amended with its reasoning; see below |

## Implementation notes

**The stop timeout needed an injectable clock, not just a no-op sleeper.** The first test
for "a proxy that keeps answering is a failure" passed a sleeper that did nothing — and
the test failed, reporting success. The loop is bounded by a wall-clock deadline, so
skipping the sleep without advancing the clock means the deadline never arrives. Both the
sleeper and `now` are injected.

The same test also exposed a harness trap worth recording: `StubProtocol` falls back to
"connection refused" once its response queue drains, which reads as a successful stop. A
test that queues too few responses will pass for the wrong reason.

**Live verification** against the running proxy (`ActionProbe`, removed after use):

```text
default provider: openai
target: anthropic enabled: true
disable    -> succeeded    proxy now reports enabled: false
re-enable  -> succeeded    proxy now reports enabled: true
default-provider guard -> failed("openai is the default provider. Choose another default…")
```

Proxy state was confirmed restored afterwards: 10 providers, 10 enabled.

`stop` is covered by the stubbed suite rather than live, per the amended criterion 1
above. The branches proven there are the ones a healthy proxy cannot demonstrate:
`success: false` from a failed native-Codex restore, a 500 mid-poll, an undecodable 200,
and a proxy that accepts the stop but keeps answering.

## Accept criteria

1. Stop behaviour proven deterministically rather than by stopping the user's proxy.
   **Amended criterion:** stopping the developer's own running proxy is out of bounds —
   it would interrupt their work, and the failure modes that matter (a 200 that never
   drains, a 500 during polling, `success: false`, an undecodable body) cannot be
   produced on demand from a healthy proxy anyway. The gate is therefore the stubbed
   transport suite, which covers every branch, plus a live read confirming the proxy is
   still healthy afterwards.
2. Provider disable + re-enable executed live and reflected in `/api/providers`.
3. The default provider's toggle is inert and explains why, using `/api/config`.
4. Failure paths surface a human sentence, never a raw body.
5. No `Process` / `NSTask` usage anywhere in `app/`.
6. `swift run --package-path app MenuBarCoreTests` green.
