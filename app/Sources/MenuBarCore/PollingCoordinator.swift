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
    /// Rises on every close and on every new refresh, so results from a superseded or
    /// abandoned cycle can be discarded instead of overwriting fresher state.
    private var generation = 0
    private var refreshInFlight = false

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
        if open {
            await refresh(includeHeavy: true)
        } else {
            // Abandon in-flight heavy work: its results are no longer visible and
            // must not land as if they were current.
            generation &+= 1
        }
    }

    /// One refresh cycle.
    ///
    /// `includeHeavy` marks a popover-open refresh: on-open reads (providers, config)
    /// always run, while the expensive aggregation reads (usage, quotas) still respect
    /// the 60s interval so reopening the popover repeatedly does not hammer the proxy.
    public func refresh(includeHeavy: Bool = false) async {
        // Overlapping cycles publish interleaved state and double the request rate.
        guard !refreshInFlight else { return }
        refreshInFlight = true
        generation &+= 1
        let cycle = generation
        defer { refreshInFlight = false }

        do {
            let health = try await client.health()
            guard cycle == generation else { return }
            snapshot.state = .running(health)
            snapshot.lastKnownStartCommand = health.manualStartCommand
            snapshot.recommendedCommand = health.recommendedCommand
            snapshot.consecutiveFailures = 0
            snapshot.lastUpdated = Date()
        } catch is CancellationError {
            // The popover closed mid-flight. Not a proxy failure; leave state untouched.
            return
        } catch let error as ProxyError {
            guard cycle == generation else { return }
            apply(error)
            publish()
            return
        } catch {
            guard cycle == generation else { return }
            apply(.transport)
            publish()
            return
        }

        if popoverOpen {
            // Cheap, changes rarely, and only meaningful while the popover is visible.
            await refreshOnOpen(cycle: cycle)

            let aggregationDue = lastHeavyRefresh.map {
                Date().timeIntervalSince($0) >= Self.heavyInterval
            } ?? true
            if includeHeavy && aggregationDue || (!includeHeavy && aggregationDue) {
                let completed = await refreshAggregation(cycle: cycle)
                // Only a fully successful aggregation counts as fresh; otherwise the
                // next cycle retries instead of waiting out a 60s window on stale data.
                if completed { lastHeavyRefresh = Date() }
            }
        }

        guard cycle == generation else { return }
        publish()
    }

    /// Reads that are only meaningful while the popover is open.
    private func refreshOnOpen(cycle: Int) async {
        if let providers = try? await client.providers(), cycle == generation {
            snapshot.providers = providers
            snapshot.providersLoaded = true
        }
        if let config = try? await client.config(), cycle == generation {
            snapshot.defaultProvider = config.defaultProvider
        }
    }

    /// The expensive aggregation reads. Returns whether every read landed, so a partial
    /// failure does not masquerade as a completed refresh.
    private func refreshAggregation(cycle: Int) async -> Bool {
        var complete = true

        // Each read is independent: one failing endpoint must not blank the others.
        if let usage = try? await client.usage(range: .sevenDays) {
            guard cycle == generation else { return false }
            snapshot.usage = usage
        } else {
            complete = false
        }

        if let quotas = try? await client.quotas() {
            guard cycle == generation else { return false }
            snapshot.quotas = quotas
            snapshot.quotasLoaded = true
        } else {
            complete = false
        }

        return complete
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
