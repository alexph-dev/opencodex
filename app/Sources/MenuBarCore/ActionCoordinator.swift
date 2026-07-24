import Foundation

/// The result of a write action, in terms the UI can render directly.
public enum ActionOutcome: Equatable, Sendable {
    case succeeded
    /// The stop was confirmed, but nothing will restart the proxy — the user has to.
    case requiresManualStart(String)
    /// A human sentence. Never a response body: bodies can echo configuration.
    case failed(String)
}

/// Executes write actions and reports what actually happened.
///
/// Split from the UI because the interesting behaviour is timing, not presentation:
/// `/api/stop` answers before it drains, so "the request returned 200" and "the proxy
/// stopped" are different facts and only the second one is worth telling the user.
public actor ActionCoordinator {
    /// How long to wait for the port to stop answering before giving up.
    public static let stopTimeout: TimeInterval = 10
    public static let pollInterval: TimeInterval = 0.5

    private let client: ProxyClient
    private let sleeper: @Sendable (TimeInterval) async -> Void
    /// Injected so tests can advance time without waiting for it. A no-op sleeper alone
    /// is not enough: the loop is bounded by a deadline, so the clock has to move too.
    private let now: @Sendable () -> Date

    public init(
        client: ProxyClient,
        sleeper: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.sleeper = sleeper
        self.now = now
    }

    /// Stops the proxy and waits until it is actually gone.
    ///
    /// `/api/stop` calls `stopServiceIfInstalled()` and returns before draining, so a
    /// 200 means "accepted", not "stopped". Reporting success on the response alone
    /// would make the UI claim a state the system has not reached yet.
    public func stop(startCommand: String) async -> ActionOutcome {
        do {
            try await client.stop()
        } catch let error as ProxyError {
            return .failed(error.userMessage)
        } catch {
            return .failed("Could not reach the proxy to stop it.")
        }

        let deadline = now().addingTimeInterval(Self.stopTimeout)
        while now() < deadline {
            await sleeper(Self.pollInterval)
            if await !client.isReachable() {
                return .requiresManualStart(startCommand)
            }
        }
        return .failed("The proxy accepted the stop but was still responding after \(Int(Self.stopTimeout)) seconds.")
    }

    /// Enables or disables a provider.
    ///
    /// The default provider is rejected before any request is sent: the proxy answers
    /// 400 for that case, and firing a request that cannot succeed is worse than not
    /// offering it.
    public func setProvider(
        _ name: String,
        disabled: Bool,
        defaultProvider: String?
    ) async -> ActionOutcome {
        if disabled, name == defaultProvider {
            return .failed("\(name) is the default provider. Choose another default in the dashboard first.")
        }
        do {
            try await client.setProviderDisabled(name, disabled: disabled)
            return .succeeded
        } catch ProxyError.http(400) {
            // The proxy validates more than we can predict; surface its refusal without
            // quoting its body.
            return .failed("The proxy refused that change. Adjust it in the dashboard.")
        } catch let error as ProxyError {
            return .failed(error.userMessage)
        } catch {
            return .failed("That change could not be applied.")
        }
    }
}
