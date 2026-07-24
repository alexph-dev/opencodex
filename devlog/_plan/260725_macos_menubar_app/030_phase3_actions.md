# 030 — Phase 3: write actions on existing endpoints

**Depends on:** `020` (the UI must exist to report a result into).
**Independently verifiable by:** a live restart and a live provider toggle against the
running proxy, with the observed response and the resulting UI state.

Constraint from the user's scope: **no new proxy endpoints.** Everything here calls
routes inventoried in `002` §4.

## File change map

| Path | Action |
| --- | --- |
| `app/Sources/MenuBarCore/ProxyClient.swift` | MODIFY — add write methods |
| `app/Sources/MenuBarCore/ActionCoordinator.swift` | NEW |
| `app/Sources/MenuBarApp/Views/ActionBarView.swift` | MODIFY — wire Restart |
| `app/Sources/MenuBarApp/Views/ProviderListView.swift` | NEW — disclosure + toggles |
| `app/Sources/MenuBarApp/Views/ConfirmSheet.swift` | NEW |
| `app/Tests/MenuBarCoreTests/ActionTests.swift` | NEW |

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

### Restart — the drain problem

`002` §4 records that `/api/stop` answers `200` **before** draining
(`src/lib/process-control.ts:77`). Treating `200` as "stopped" would make the UI lie for
several seconds.

```swift
public enum ActionOutcome: Equatable, Sendable {
    case succeeded
    case failed(String)          // user-facing text, never a raw response body
    case requiresManualStart     // stop confirmed; the app cannot relaunch it
}

public func restart() async -> ActionOutcome {
    do { try await client.stop() } catch { return .failed("Could not reach the proxy to stop it.") }

    // Poll until the port stops answering, up to 10s, before claiming anything.
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
        try? await Task.sleep(for: .milliseconds(500))
        if await !client.isReachable() { return await waitForRestart() }
    }
    return .failed("The proxy did not stop within 10 seconds.")
}
```

### The honesty problem with "Restart"

The management API can stop the proxy. **It cannot start one** — there is no start
endpoint, and by scope we are not adding one. A button labelled "Restart" that can only
stop is exactly the "fake completion" tell `003` §6 bans.

Two options were considered:

1. Shell out to `ocx start` (what PR #387 does via `OcxClient.perform`).
2. Label the control truthfully and let the service supervisor do its job.

**Decision: option 2 for the default path, with option 1 available only when a
service-managed proxy is detected.** `/api/startup-health` already reports
`serviceInstalled`, `serviceRunning`, and `serviceEnabled` (`002` §3). When
`serviceInstalled && serviceEnabled`, launchd restarts the proxy on its own, so "Restart"
is genuinely a restart and the app polls until it comes back. When no service is
installed, the button is labelled **"Stop proxy"** and the resulting state offers the
exact command to start it again. The app does not silently spawn processes the user did
not ask for.

```swift
var restartLabel: String { health.serviceManaged ? "Restart" : "Stop proxy" }
```

### Provider toggle — the default-provider trap

`002` §4 records `provider-routes.ts:178`: disabling `config.defaultProvider` returns
`400` with `"cannot disable the default provider; set another default first"`.

Per `dev-uiux-design` UX-LAZY-01, firing a request guaranteed to fail is not acceptable.
The toggle is disabled up front with an explanatory tooltip:

```swift
let isDefault = provider.name == settings.defaultProvider
toggle.isEnabled = !isDefault
toggle.toolTip = isDefault
    ? "This is the default provider. Choose another default in the dashboard first."
    : nil
```

`/api/settings` supplies `defaultProvider`, so no extra call is needed.

Optimistic update with rollback: flip the switch immediately, send the PATCH, and revert
with an inline error on failure. Reverting is the required behaviour — leaving a switch
in a state the server rejected is the "fake state" tell.

## Confirmation policy

| Action | Confirmation | Why |
| --- | --- | --- |
| Stop / Restart proxy | **Yes** — sheet | Disruptive: kills in-flight requests |
| Provider disable | No — optimistic + undo | Cheap and reversible |
| Provider enable | No | Strictly additive |

`dev-uiux-design` UX-LAZY-01 exempts destructive actions from magic defaults, and stopping
a proxy mid-request is destructive. Everything else stays frictionless.

`ConfirmSheet` states the concrete consequence — "In-flight requests will be
interrupted." — not a generic "Are you sure?".

## Security rules

- Write requests carry the key in `x-opencodex-api-key`, read from the Keychain lazily
  (`010`), and never in a URL query.
- No response body ever reaches a log, an error string, or the UI verbatim. Failures map
  to a fixed set of human sentences.
- No shell execution on the default path. The service-managed restart path is the only
  process interaction, and only when `startup-health` proves a supervisor exists.
- The app never writes to `~/.opencodex/config.json` directly; all mutation goes through
  the management API so the proxy's own validation runs.

## Tests (`ActionTests`)

Stubbed `URLProtocol`:

- `stop()` on `200` → `.succeeded` only after reachability actually drops.
- `stop()` where the port keeps answering → `.failed`, never a false success.
- `setProviderDisabled` sends `PATCH /api/providers?name=x` with body exactly
  `{"disabled":true}`.
- A `400` response reverts the optimistic toggle.
- The default provider's toggle is disabled before any request is attempted.
- No error path leaks a response body into `ActionOutcome`.

## Accept criteria

1. Stop/Restart executed live against the running proxy, with the observed outcome.
2. Provider disable + re-enable executed live and reflected in `/api/providers`.
3. The default provider's toggle is inert and explains why.
4. Failure paths surface a human sentence, never a raw body.
5. `swift test --package-path app` green.
