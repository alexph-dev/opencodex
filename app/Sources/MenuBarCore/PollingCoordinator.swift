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
    private var observers: [UUID: @Sendable (ProxySnapshot) -> Void] = [:]
    /// Rises on every close and on every new refresh, so results from a superseded or
    /// abandoned cycle can be discarded instead of overwriting fresher state.
    private var generation = 0
    private var refreshInFlight = false
    /// A refresh requested while another was in flight. Without this, closing and
    /// immediately reopening the popover dropped the reopen's refresh entirely: the old
    /// cycle exited on its generation guard and the new one had already been rejected.
    private var pendingOpenRefresh = false
    /// Attempt time, distinct from success time: a persistently failing endpoint must
    /// not turn its healthy sibling into a 5-second poller.
    private var lastAggregationAttempt: Date?

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
        guard !refreshInFlight else {
            if includeHeavy { pendingOpenRefresh = true }
            return
        }
        refreshInFlight = true
        generation &+= 1
        let cycle = generation
        defer { refreshInFlight = false }

        do {
            let health = try await client.health()
            guard cycle == generation else {
                refreshInFlight = false
                await drainPendingRefresh()
                return
            }
            snapshot.state = .running(health)
            snapshot.lastKnownStartCommand = health.manualStartCommand
            snapshot.recommendedCommand = health.recommendedCommand
            snapshot.consecutiveFailures = 0
            snapshot.lastUpdated = Date()
        } catch is CancellationError {
            // The popover closed mid-flight. Not a proxy failure; leave state untouched.
            refreshInFlight = false
            await drainPendingRefresh()
            return
        } catch let error as ProxyError {
            if cycle == generation { apply(error); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            return
        } catch {
            if cycle == generation { apply(.transport); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            return
        }

        if popoverOpen {
            // Only on an actual open or manual refresh. Running these on every liveness
            // tick turned two rarely-changing endpoints into 5-second pollers.
            if includeHeavy { await refreshOnOpen(cycle: cycle) }

            // Rate-limit on ATTEMPT, not success: gating on success alone meant one
            // persistently failing endpoint re-fetched its healthy sibling every 5s.
            let aggregationDue = lastAggregationAttempt.map {
                Date().timeIntervalSince($0) >= Self.heavyInterval
            } ?? true
            if aggregationDue, isCurrent(cycle) {
                lastAggregationAttempt = Date()
                _ = await refreshAggregation(cycle: cycle)
            }
        }

        if cycle == generation { publish() }
        refreshInFlight = false
        await drainPendingRefresh()
    }

    /// Runs a refresh that arrived while another cycle held the lock.
    private func drainPendingRefresh() async {
        guard pendingOpenRefresh, popoverOpen else {
            pendingOpenRefresh = false
            return
        }
        pendingOpenRefresh = false
        await refresh(includeHeavy: true)
    }

    /// Reads that are only meaningful while the popover is open.
    private func refreshOnOpen(cycle: Int) async {
        guard isCurrent(cycle) else { return }
        if let providers = try? await client.providers(), isCurrent(cycle) {
            snapshot.providers = providers
            snapshot.providersLoaded = true
        }
        // Re-check before each subsequent request: closing mid-flight should stop the
        // sequence, not merely discard its results after paying for them.
        guard isCurrent(cycle) else { return }
        if let config = try? await client.config(), isCurrent(cycle) {
            snapshot.defaultProvider = config.defaultProvider
        }
    }

    /// Still the newest cycle, and still worth doing.
    private func isCurrent(_ cycle: Int) -> Bool { cycle == generation && popoverOpen }

    /// The expensive aggregation reads. Returns whether every read landed, so a partial
    /// failure does not masquerade as a completed refresh.
    private func refreshAggregation(cycle: Int) async -> Bool {
        guard isCurrent(cycle) else { return false }
        var complete = true

        // Each read is independent: one failing endpoint must not blank the others.
        if let usage = try? await client.usage(range: .sevenDays) {
            guard isCurrent(cycle) else { return false }
            snapshot.usage = usage
            snapshot.usageUpdated = Date()
        } else {
            complete = false
        }

        guard isCurrent(cycle) else { return false }
        if let quotas = try? await client.quotas() {
            guard isCurrent(cycle) else { return false }
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
