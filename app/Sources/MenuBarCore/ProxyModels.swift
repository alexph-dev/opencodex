import Foundation

// Codable mirrors of the management API payloads inventoried in
// devlog/_plan/260725_macos_menubar_app/002_api_surface.md.
//
// Every field the proxy may omit is optional. The proxy is a fast-moving local service;
// a companion that fails to decode because one field moved is worse than one that shows
// an em dash.

/// `GET /api/startup-health`
public struct StartupHealth: Decodable, Equatable, Sendable {
    public let status: String?
    public let protection: String?
    public let platform: String?
    public let routingKind: String?
    public let serviceRunning: Bool?
    public let serviceInstalled: Bool?
    public let serviceEnabled: Bool?
    public let rebootSafe: Bool?
    public let recommendedCommand: String?

    public init(
        status: String? = nil,
        protection: String? = nil,
        platform: String? = nil,
        routingKind: String? = nil,
        serviceRunning: Bool? = nil,
        serviceInstalled: Bool? = nil,
        serviceEnabled: Bool? = nil,
        rebootSafe: Bool? = nil,
        recommendedCommand: String? = nil
    ) {
        self.status = status
        self.protection = protection
        self.platform = platform
        self.routingKind = routingKind
        self.serviceRunning = serviceRunning
        self.serviceInstalled = serviceInstalled
        self.serviceEnabled = serviceEnabled
        self.rebootSafe = rebootSafe
        self.recommendedCommand = recommendedCommand
    }

    /// `status` is treated as an open string: unknown values degrade to a neutral state
    /// rather than crashing or being coerced into "healthy".
    public var isProtected: Bool { status == "protected" }

    /// True when a supervisor owns the process lifecycle. Used only for the qualifier
    /// line — it deliberately does not gate any action, because `/api/stop` stops the
    /// service on purpose and nothing restarts the proxy automatically.
    public var isServiceManaged: Bool {
        (serviceInstalled ?? false) && (serviceEnabled ?? false)
    }

    /// The command to show the user when the proxy is not running.
    public var manualStartCommand: String {
        isServiceManaged ? "ocx service start" : "ocx start"
    }
}

/// `GET /api/settings`. Note the absence of `defaultProvider` — it lives on
/// `/api/config`, verified against the live key set.
public struct ProxySettings: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let streamMode: String?
    public let codexAutoStart: Bool?
}

/// `GET /api/config` — the only source of `defaultProvider`.
public struct ProxyConfigSummary: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let defaultProvider: String?
}

/// Ranges accepted by `parseRange()` in `src/usage/summary.ts`.
///
/// Closed on purpose: the server silently degrades anything else to `30d`, so a
/// stringly-typed range would let a caller ask for `24h`, receive thirty days of data,
/// and label it wrongly.
public enum UsageRange: String, Sendable, CaseIterable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all
}

public struct UsageSummary: Decodable, Equatable, Sendable {
    public let requests: Int?
    public let measuredRequests: Int?
    public let estimatedRequests: Int?
    public let totalTokens: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCostUsd: Double?
    public let coverageRatio: Double?

    public var hasEstimates: Bool { (estimatedRequests ?? 0) > 0 }
}

public struct UsageDay: Decodable, Equatable, Sendable {
    public let date: String
    public let requests: Int?
    public let totalTokens: Int?
}

public struct UsageReport: Decodable, Equatable, Sendable {
    public let range: String?
    public let surface: String?
    public let generatedAt: Double?
    public let summary: UsageSummary?
    public let days: [UsageDay]?

    /// The range the server actually applied, which is not always the one requested.
    public var effectiveRange: UsageRange? {
        range.flatMap(UsageRange.init(rawValue:))
    }

    /// Header text driven by the response, never by the request.
    public var rangeLabel: String {
        switch effectiveRange {
        case .sevenDays: return "LAST 7 DAYS"
        case .thirtyDays: return "LAST 30 DAYS"
        case .all: return "ALL TIME"
        case nil: return "USAGE"
        }
    }

    public var isEmpty: Bool {
        guard let summary else { return true }
        return (summary.requests ?? 0) == 0
    }
}

public struct QuotaWindow: Decodable, Equatable, Sendable {
    public let label: String?
    public let percent: Double?
    public let resetAt: Double?
}

public struct ProviderQuota: Decodable, Equatable, Sendable {
    public let weeklyPercent: Double?
    public let monthlyPercent: Double?
    public let weeklyResetAt: Double?
    public let monthlyResetAt: Double?
    public let customWindows: [QuotaWindow]?
    public let updatedAt: Double?
}

public struct QuotaReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let label: String?
    public let source: String?
    public let quota: ProviderQuota?
}

/// A provider-agnostic view of quota, since the window key differs per provider.
public struct NormalizedQuota: Equatable, Sendable {
    public let provider: String
    public let providerLabel: String
    public let percent: Double?
    public let windowLabel: String
    public let resetAt: Date?

    public var hasPercent: Bool { percent != nil }
}

public extension QuotaReport {
    /// Timestamps in this payload are not uniform: the live proxy returns
    /// `weeklyResetAt` in seconds for `openai` and in milliseconds for `anthropic`,
    /// within the same array. Disambiguate by magnitude — 1e12 is 2001 read as
    /// milliseconds and year 33658 read as seconds, so the boundary is unambiguous for
    /// any timestamp this app will ever see.
    static func date(from value: Double?) -> Date? {
        guard let value, value > 0 else { return nil }
        let seconds = value >= 1_000_000_000_000 ? value / 1000 : value
        return Date(timeIntervalSince1970: seconds)
    }

    func normalized() -> NormalizedQuota {
        let name = label ?? provider
        if let percent = quota?.weeklyPercent {
            return NormalizedQuota(
                provider: provider, providerLabel: name, percent: percent,
                windowLabel: "week", resetAt: Self.date(from: quota?.weeklyResetAt)
            )
        }
        if let percent = quota?.monthlyPercent {
            return NormalizedQuota(
                provider: provider, providerLabel: name, percent: percent,
                windowLabel: "month", resetAt: Self.date(from: quota?.monthlyResetAt)
            )
        }
        if let window = quota?.customWindows?.first {
            return NormalizedQuota(
                provider: provider, providerLabel: name, percent: window.percent,
                windowLabel: window.label ?? "window", resetAt: Self.date(from: window.resetAt)
            )
        }
        return NormalizedQuota(
            provider: provider, providerLabel: name, percent: nil,
            windowLabel: "—", resetAt: nil
        )
    }
}

/// `GET /api/providers`. `hasApiKey` is a presence flag; the key never leaves the proxy.
public struct ProviderSummary: Decodable, Equatable, Sendable {
    public let name: String
    public let adapter: String?
    public let authMode: String?
    public let hasApiKey: Bool?
    public let disabled: Bool?

    public var isEnabled: Bool { !(disabled ?? false) }
}
