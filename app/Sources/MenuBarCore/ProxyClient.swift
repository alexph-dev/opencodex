import Foundation

public enum ProxyError: Error, Equatable {
    /// Connection refused or timed out — the proxy is not running.
    case unreachable
    /// 401 — a non-loopback bind that requires a credential.
    case unauthorized
    case http(Int)
    case decoding

    /// Human sentences only. Response bodies can echo configuration values, so they
    /// never reach the UI or a log.
    public var userMessage: String {
        switch self {
        case .unreachable: return "The proxy is not running."
        case .unauthorized: return "This proxy requires an API key."
        case .http(let code): return "The proxy returned an unexpected status (\(code))."
        case .decoding: return "The proxy returned a response this app could not read."
        }
    }
}

/// HTTP client for the OpenCodex management API.
///
/// An actor because the endpoint and key are mutated from both the polling loop and user
/// actions; the isolation makes that data-race-free by construction rather than by
/// convention.
public actor ProxyClient {
    private let session: URLSession
    private var endpoint: ProxyEndpoint
    private var apiKey: String?

    public init(endpoint: ProxyEndpoint, session: URLSession? = nil) {
        self.endpoint = endpoint
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 4
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    public var currentEndpoint: ProxyEndpoint { endpoint }

    public func updateEndpoint(_ endpoint: ProxyEndpoint) { self.endpoint = endpoint }

    public func setAPIKey(_ key: String?) { self.apiKey = key }

    // MARK: - Reads

    public func health() async throws -> StartupHealth { try await get("api/startup-health") }
    public func settings() async throws -> ProxySettings { try await get("api/settings") }
    public func config() async throws -> ProxyConfigSummary { try await get("api/config") }
    public func providers() async throws -> [ProviderSummary] { try await get("api/providers") }

    public func usage(range: UsageRange = .sevenDays) async throws -> UsageReport {
        try await get("api/usage", query: [URLQueryItem(name: "range", value: range.rawValue)])
    }

    public func quotas() async throws -> [QuotaReport] {
        let envelope: QuotaEnvelope = try await get("api/provider-quotas")
        return envelope.reports ?? []
    }

    /// Cheapest possible liveness probe.
    public func isReachable() async -> Bool {
        do {
            _ = try await settings()
            return true
        } catch ProxyError.unauthorized {
            // Answering 401 still proves something is listening.
            return true
        } catch {
            return false
        }
    }

    // MARK: - Writes

    /// `POST /api/stop`. Returns once the proxy has accepted the request.
    ///
    /// The proxy answers 200 *before* draining, and it stops the launchd service first so
    /// nothing respawns it. Callers must poll `isReachable()` rather than treat this
    /// return as "stopped".
    public func stop() async throws {
        _ = try await send(method: "POST", path: "api/stop", body: nil as EmptyBody?)
    }

    /// `PATCH /api/providers?name=<name>` with a body of exactly `{"disabled": <bool>}`.
    ///
    /// A disabled-only patch skips the proxy's heavier merged-shape validators, so adding
    /// any second field would silently change the request class.
    public func setProviderDisabled(_ name: String, disabled: Bool) async throws {
        _ = try await send(
            method: "PATCH",
            path: "api/providers",
            query: [URLQueryItem(name: "name", value: name)],
            body: ProviderDisabledPatch(disabled: disabled)
        )
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await send(method: "GET", path: path, query: query, body: nil as EmptyBody?)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ProxyError.decoding
        }
    }

    private func send<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?
    ) async throws -> Data {
        guard var components = URLComponents(
            url: endpoint.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { throw ProxyError.decoding }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw ProxyError.decoding }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = method == "GET" ? 4 : 6
        if let apiKey { request.setValue(apiKey, forHTTPHeaderField: "x-opencodex-api-key") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONEncoder().encode(body)
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ProxyError.decoding }
            if http.statusCode == 401 { throw ProxyError.unauthorized }
            guard (200..<300).contains(http.statusCode) else {
                throw ProxyError.http(http.statusCode)
            }
            return data
        } catch let error as ProxyError {
            throw error
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .timedOut, .networkConnectionLost,
                 .cannotFindHost, .notConnectedToInternet:
                throw ProxyError.unreachable
            default:
                throw ProxyError.unreachable
            }
        }
    }
}

private struct QuotaEnvelope: Decodable {
    let generatedAt: Double?
    let reports: [QuotaReport]?
}

private struct ProviderDisabledPatch: Encodable {
    let disabled: Bool
}

private struct EmptyBody: Encodable {}
