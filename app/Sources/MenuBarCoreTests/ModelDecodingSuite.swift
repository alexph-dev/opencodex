import Foundation
import MenuBarCore

/// Fixtures are verbatim captures from the live proxy on 2026-07-25, recorded in
/// devlog/_plan/260725_macos_menubar_app/002_api_surface.md. Hand-written fixtures would
/// only prove the models decode themselves.
enum ModelDecodingSuite {
    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private struct Envelope: Decodable { let reports: [QuotaReport]? }

    private static let liveHealth = """
    {"routingKind":"opencodex-local","autostartEnabled":false,"serviceInstalled":true,
     "serviceViable":true,"serviceEnabled":true,"serviceRunning":true,"serviceStale":false,
     "serviceConflict":false,"serviceSupported":true,"shimInstalled":false,
     "shimHealthy":false,"platform":"darwin","diagnosticStale":true,"routingInjected":true,
     "localRoutingDependency":true,"status":"at-risk","rebootSafe":false,"protection":"none",
     "shimCoverage":"none","recommendedCommand":"ocx service install",
     "commands":{"installService":"ocx service install","installShim":"ocx codex-shim install",
     "restoreNative":"ocx restore"}}
    """

    private static let liveQuotas = """
    {"generatedAt":1784915336899,"reports":[
      {"provider":"openai","label":"OpenAI (Codex login)","source":"chatgpt:wham",
       "quota":{"updatedAt":1784915090763,"weeklyPercent":44,"weeklyResetAt":1785258443,
                "resetCredits":3}},
      {"provider":"anthropic","label":"Anthropic Claude","source":"anthropic:oauth-usage",
       "quota":{"weeklyPercent":58,"weeklyResetAt":1785265199718,
                "customWindows":[{"label":"5h","percent":1,"resetAt":1784928599718}]}},
      {"provider":"xai","label":"xAI Grok","source":"xai:grok-billing",
       "quota":{"monthlyPercent":86.82666666666667,"monthlyResetAt":1785542400000}}]}
    """

    static func run(_ t: TestRunner) {
        t.test("health: decodes the live startup-health payload") {
            let health = try decode(StartupHealth.self, liveHealth)
            t.equal(health.status, "at-risk")
            t.equal(health.platform, "darwin")
            t.equal(health.recommendedCommand, "ocx service install")
            t.equal(health.isProtected, false)
            t.equal(health.isServiceManaged, true)
            t.equal(health.manualStartCommand, "ocx service start")
        }

        t.test("health: an unknown status string decodes without throwing") {
            let health = try decode(StartupHealth.self, #"{"status":"some-future-state"}"#)
            t.equal(health.status, "some-future-state")
            t.equal(health.isProtected, false)
        }

        t.test("health: without service fields it is not service-managed") {
            let health = try decode(StartupHealth.self, #"{"status":"protected"}"#)
            t.equal(health.isProtected, true)
            t.equal(health.isServiceManaged, false)
            t.equal(health.manualStartCommand, "ocx start")
        }

        // The live /api/settings key set contains no defaultProvider. Decoding must
        // succeed anyway — an earlier plan draft expected the field here and was wrong.
        t.test("settings: decodes without a defaultProvider field") {
            let json = """
            {"codexAutoStart":false,"port":10100,"hostname":"127.0.0.1","streamMode":"auto",
             "startupHealth":{"status":"protected"},"codexRuntime":{}}
            """
            let settings = try decode(ProxySettings.self, json)
            t.equal(settings.port, 10100)
            t.equal(settings.hostname, "127.0.0.1")
            t.equal(settings.streamMode, "auto")
        }

        t.test("config: supplies defaultProvider") {
            let json = """
            {"port":10100,"hostname":"127.0.0.1","defaultProvider":"openai",
             "codexAutoStart":false,"websockets":{},"providers":{}}
            """
            t.equal(try decode(ProxyConfigSummary.self, json).defaultProvider, "openai")
        }

        t.test("usage: decodes the live summary at real magnitudes") {
            let json = """
            {"range":"30d","surface":"all","since":1782323333603,"generatedAt":1784915333603,
             "summary":{"requests":232507,"measuredRequests":225380,"estimatedRequests":14618,
              "inputTokens":33521662469,"outputTokens":127401110,"totalTokens":36536664705,
              "coverageRatio":0.969347159440361,"estimatedCostUsd":34018.25204647066},
             "days":[{"date":"2026-06-28","requests":1746,"totalTokens":0,"models":[]}]}
            """
            let report = try decode(UsageReport.self, json)
            t.equal(report.summary?.requests, 232_507)
            t.equal(report.summary?.totalTokens, 36_536_664_705)
            t.equal(report.effectiveRange, .thirtyDays)
            t.equal(report.rangeLabel, "LAST 30 DAYS")
            t.equal(report.summary?.hasEstimates, true)
            t.equal(report.isEmpty, false)
        }

        // The server silently degrades an unrecognized range to 30d, so the label must
        // follow the response and never the request.
        t.test("usage: an unknown range degrades to a neutral label") {
            let report = try decode(UsageReport.self, #"{"range":"24h"}"#)
            t.isNil(report.effectiveRange, "effectiveRange for 24h")
            t.equal(report.rangeLabel, "USAGE")
        }

        t.test("usage: zero requests reads as empty") {
            let report = try decode(UsageReport.self, #"{"range":"7d","summary":{"requests":0}}"#)
            t.equal(report.isEmpty, true)
        }

        t.test("usage: the range enum is closed") {
            t.isNil(UsageRange(rawValue: "24h"), "UsageRange(24h)")
            t.equal(UsageRange.allCases.map(\.rawValue), ["7d", "30d", "all"])
        }

        // The decisive trap: openai sends weeklyResetAt in SECONDS (1785258443) while
        // anthropic sends MILLISECONDS (1785265199718) in the same array.
        t.test("quotas: mixed second and millisecond timestamps both resolve to 2026") {
            let reports = try decode(Envelope.self, liveQuotas).reports ?? []
            t.equal(reports.count, 3)
            let calendar = Calendar(identifier: .gregorian)
            for report in reports {
                let normalized = report.normalized()
                guard let date = t.notNil(normalized.resetAt, "\(report.provider) resetAt") else { continue }
                t.equal(calendar.component(.year, from: date), 2026, "\(report.provider) year")
            }
        }

        t.test("quotas: normalization picks the right window per provider") {
            let reports = try decode(Envelope.self, liveQuotas).reports ?? []
            let byProvider = Dictionary(uniqueKeysWithValues: reports.map { ($0.provider, $0.normalized()) })
            t.equal(byProvider["openai"]?.windowLabel, "week")
            t.equal(byProvider["openai"]?.percent, 44)
            t.equal(byProvider["anthropic"]?.windowLabel, "week")
            t.equal(byProvider["xai"]?.windowLabel, "month")
            t.equal(byProvider["xai"]?.providerLabel, "xAI Grok")
        }

        t.test("quotas: a custom-window-only quota uses its own label") {
            let json = """
            {"provider":"p","quota":{"customWindows":[{"label":"5h","percent":12,"resetAt":1784928599718}]}}
            """
            let normalized = try decode(QuotaReport.self, json).normalized()
            t.equal(normalized.windowLabel, "5h")
            t.equal(normalized.percent, 12)
        }

        t.test("quotas: an absent quota normalizes to a nil percent") {
            let normalized = try decode(QuotaReport.self, #"{"provider":"p","label":"P"}"#).normalized()
            t.isNil(normalized.percent, "percent")
            t.equal(normalized.hasPercent, false)
            t.isNil(normalized.resetAt, "resetAt")
        }

        t.test("providers: decodes the live list") {
            let json = """
            [{"name":"openai","adapter":"openai-responses","hasApiKey":false,
              "authMode":"forward","disabled":false,"codexAccountMode":"pool"},
             {"name":"anthropic","adapter":"anthropic","hasApiKey":false,
              "authMode":"oauth","disabled":true}]
            """
            let providers = try decode([ProviderSummary].self, json)
            t.equal(providers.count, 2)
            t.equal(providers[0].name, "openai")
            t.equal(providers[0].isEnabled, true)
            t.equal(providers[1].isEnabled, false)
        }

        t.test("providers: a provider without a disabled field is enabled") {
            t.equal(try decode(ProviderSummary.self, #"{"name":"custom"}"#).isEnabled, true)
        }
    }
}
