import Foundation

/// Owns the refresh schedule and turns transport results into a `ProxySnapshot`.
///
/// Polling is deliberately conservative. A menu bar app that hits a local server every
/// five seconds forever is a battery complaint waiting to happen, so heavy aggregation
/// endpoints are fetched only while the popover is open, and repeated failures back the
/// liveness tick off rather than hammering a proxy the user has stopped on purpose.
public actor PollingCoordinator {
    public static let livenessInterval: TimeInterval = 5
    public static let heavyInterval: TimeInterval = 60
    public static let backoffInterval: TimeInterval = 30
    public static let backoffAfterFailures = 3

    private let client: ProxyClient
    private var snapshot: ProxySnapshot
    private var popoverOpen = false
    private var lastHeavyRefresh: Date?
    private var observers: [UUID: @Sendable (ProxySnapshot) -> Void] = [:]

    public init(client: ProxyClient, endpoint: ProxyEndpoint) {
        self.client = client
        self.snapshot = ProxySnapshot(endpoint: endpoint)
    }

    public var current: ProxySnapshot { snapshot }

    /// Interval until the next liveness tick, widened once failures pile up.
    public var currentInterval: TimeInterval {
        snapshot.consecutiveFailures >= Self.backoffAfterFailures
            ? Self.backoffInterval
            : Self.livenessInterval
    }

    @discardableResult
    public func observe(_ handler: @escaping @Sendable (ProxySnapshot) -> Void) -> UUID {
        let token = UUID()
        observers[token] = handler
        handler(snapshot)
        return token
    }

    public func removeObserver(_ token: UUID) { observers[token] = nil }

    public func setPopoverOpen(_ open: Bool) async {
        popoverOpen = open
        if open { await refresh(includeHeavy: true) }
    }

    /// One refresh cycle. Heavy endpoints are skipped unless the popover is open and the
    /// heavy interval has elapsed.
    public func refresh(includeHeavy: Bool = false) async {
        do {
            let health = try await client.health()
            snapshot.state = .running(health)
            snapshot.lastKnownStartCommand = health.manualStartCommand
            snapshot.consecutiveFailures = 0
            snapshot.lastUpdated = Date()
        } catch is CancellationError {
            // The popover closed mid-flight. Not a proxy failure; leave state untouched.
            return
        } catch let error as ProxyError {
            apply(error)
            publish()
            return
        } catch {
            apply(.transport)
            publish()
            return
        }

        let heavyDue = includeHeavy || lastHeavyRefresh.map {
            Date().timeIntervalSince($0) >= Self.heavyInterval
        } ?? true

        if popoverOpen && heavyDue {
            await refreshHeavy()
            lastHeavyRefresh = Date()
        }

        publish()
    }

    private func refreshHeavy() async {
        // Each read is independent: one failing endpoint must not blank the others.
        if let usage = try? await client.usage(range: .sevenDays) { snapshot.usage = usage }
        if let quotas = try? await client.quotas() { snapshot.quotas = quotas }
        if let providers = try? await client.providers() { snapshot.providers = providers }
        if let config = try? await client.config() { snapshot.defaultProvider = config.defaultProvider }
    }

    private func apply(_ error: ProxyError) {
        snapshot.consecutiveFailures += 1
        switch error {
        case .unreachable:
            snapshot.state = .unreachable
        case .unauthorized:
            snapshot.state = .unauthorized
        case .http, .decoding, .transport:
            snapshot.state = .degraded(error.userMessage)
        }
    }

    private func publish() {
        let value = snapshot
        for handler in observers.values { handler(value) }
    }
}
