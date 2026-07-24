import Foundation
import MenuBarCore

/// Write-action behaviour, especially the timing: `/api/stop` answers before it drains,
/// so "returned 200" and "actually stopped" are different facts.
enum ActionSuite {
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private static func sync<T>(_ operation: @escaping () async -> T) -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = Box<T>()
        Task {
            box.value = await operation()
            semaphore.signal()
        }
        semaphore.wait()
        return box.value!
    }

    private final class Box<T>: @unchecked Sendable { var value: T? }
    private struct NoCredentials: CredentialStore { func loadAPIKey() -> String? { nil } }

    /// A clock the test drives, so the timeout path runs in milliseconds.
    private final class FakeClock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSince1970: 1_784_915_000)
        func now() -> Date { lock.lock(); defer { lock.unlock() }; return current }
        func advance(_ seconds: TimeInterval) {
            lock.lock(); current = current.addingTimeInterval(seconds); lock.unlock()
        }
    }

    private static func makeCoordinator(clock: FakeClock = FakeClock()) -> ActionCoordinator {
        let client = ProxyClient(endpoint: .default, session: makeSession(), credentials: NoCredentials())
        // Skip the real wall-clock wait, but advance the clock by the same amount so the
        // deadline still expires.
        return ActionCoordinator(
            client: client,
            sleeper: { seconds in clock.advance(seconds) },
            now: { clock.now() }
        )
    }

    private static func paths() -> [String] {
        StubProtocol.recorded.compactMap { $0.url?.path }
    }

    static func run(_ t: TestRunner) {
        // The proxy stops the launchd service on purpose, so a successful stop is
        // reported as "you will have to start it again", not as a plain success.
        t.test("stop: reports manual-start once the port stops answering") {
            StubProtocol.reset([
                .init(status: 200, body: "{}", urlError: nil),                    // POST /api/stop
                .init(status: 0, body: "", urlError: .cannotConnectToHost),       // probe: gone
            ])
            let outcome = sync { await makeCoordinator().stop(startCommand: "ocx service start") }
            t.equal(outcome, .requiresManualStart("ocx service start"))
            t.expect(paths().first == "/api/stop", "stop called first, got \(paths())")
        }

        // A 200 that never drains must not be reported as success.
        t.test("stop: a proxy that keeps answering is a failure, not a success") {
            // The stub falls back to "connection refused" once its queue drains, which
            // would look like a successful stop. Queue well past the poll count so the
            // timeout path is what actually runs.
            var responses: [StubProtocol.Response] = [.init(status: 200, body: "{}", urlError: nil)]
            responses.append(contentsOf: Array(
                repeating: .init(status: 200, body: #"{"port":10100}"#, urlError: nil),
                count: 400
            ))
            StubProtocol.reset(responses)
            let clock = FakeClock()
            let outcome = sync { await makeCoordinator(clock: clock).stop(startCommand: "ocx start") }
            if case .failed(let message) = outcome {
                t.expect(message.contains("still responding"), "expected a timeout message, got \(message)")
            } else {
                t.expect(false, "expected .failed, got \(outcome)")
            }
        }

        t.test("stop: an unreachable proxy fails without claiming it stopped anything") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let outcome = sync { await makeCoordinator().stop(startCommand: "ocx start") }
            t.equal(outcome, .failed(ProxyError.unreachable.userMessage))
        }

        t.test("stop: a failure message never carries the response body") {
            StubProtocol.reset([.init(status: 500, body: "SECRET-CONFIG", urlError: nil)])
            let outcome = sync { await makeCoordinator().stop(startCommand: "ocx start") }
            if case .failed(let message) = outcome {
                t.expect(!message.contains("SECRET"), "leaked body: \(message)")
            } else {
                t.expect(false, "expected .failed, got \(outcome)")
            }
        }

        t.test("provider: disabling sends exactly one PATCH and succeeds") {
            StubProtocol.reset([.init(status: 200, body: "{}", urlError: nil)])
            let outcome = sync {
                await makeCoordinator().setProvider("anthropic", disabled: true, defaultProvider: "openai")
            }
            t.equal(outcome, .succeeded)
            t.equal(StubProtocol.recorded.count, 1)
            t.equal(StubProtocol.recorded.first?.httpMethod, "PATCH")
            let url = StubProtocol.recorded.first?.url?.absoluteString ?? ""
            t.expect(url.contains("name=anthropic"), "expected name=anthropic in \(url)")
        }

        // The proxy answers 400 for this, so the request is never sent at all.
        t.test("provider: the default provider is refused before any request") {
            StubProtocol.reset([.init(status: 200, body: "{}", urlError: nil)])
            let outcome = sync {
                await makeCoordinator().setProvider("openai", disabled: true, defaultProvider: "openai")
            }
            if case .failed(let message) = outcome {
                t.expect(message.contains("default provider"), "expected an explanation, got \(message)")
            } else {
                t.expect(false, "expected .failed, got \(outcome)")
            }
            t.equal(StubProtocol.recorded.count, 0, "no request should be sent")
        }

        t.test("provider: enabling the default provider is allowed") {
            StubProtocol.reset([.init(status: 200, body: "{}", urlError: nil)])
            let outcome = sync {
                await makeCoordinator().setProvider("openai", disabled: false, defaultProvider: "openai")
            }
            t.equal(outcome, .succeeded)
        }

        t.test("provider: a 400 from the proxy surfaces without quoting its body") {
            StubProtocol.reset([.init(status: 400, body: "cannot disable the default provider", urlError: nil)])
            let outcome = sync {
                await makeCoordinator().setProvider("x", disabled: true, defaultProvider: "openai")
            }
            if case .failed(let message) = outcome {
                t.expect(!message.contains("cannot disable"), "leaked body: \(message)")
                t.expect(message.contains("refused"), "expected a refusal message, got \(message)")
            } else {
                t.expect(false, "expected .failed, got \(outcome)")
            }
        }

        t.test("provider: an unreachable proxy fails cleanly") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let outcome = sync {
                await makeCoordinator().setProvider("x", disabled: false, defaultProvider: nil)
            }
            t.equal(outcome, .failed(ProxyError.unreachable.userMessage))
        }

        t.test("actions: no outcome message is empty") {
            let outcomes: [ActionOutcome] = [
                .succeeded,
                .requiresManualStart("ocx start"),
                .failed("something went wrong"),
            ]
            for outcome in outcomes {
                switch outcome {
                case .succeeded: break
                case .requiresManualStart(let value), .failed(let value):
                    t.expect(!value.isEmpty, "outcome carried an empty message")
                }
            }
        }
    }
}
