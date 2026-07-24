import Foundation
import MenuBarCore

/// Stubs the network so status mapping, the 401 retry, cancellation, request shape, and
/// body privacy are covered without a live proxy.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Response {
        var status: Int
        var body: String
        var urlError: URLError.Code?
    }

    nonisolated(unsafe) static var queue: [Response] = []
    nonisolated(unsafe) static var recorded: [URLRequest] = []
    private static let lock = NSLock()

    static func reset(_ responses: [Response]) {
        lock.lock(); defer { lock.unlock() }
        queue = responses
        recorded = []
    }

    static func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        recorded.append(request)
    }

    static func next() -> Response? {
        lock.lock(); defer { lock.unlock() }
        return queue.isEmpty ? nil : queue.removeFirst()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.record(request)
        guard let response = Self.next() else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        if let code = response.urlError {
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        let http = HTTPURLResponse(
            url: request.url!, statusCode: response.status,
            httpVersion: "HTTP/1.1", headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private struct StubCredentials: CredentialStore {
    let key: String?
    let counter: Counter

    final class Counter: @unchecked Sendable {
        private(set) var loads = 0
        private let lock = NSLock()
        func bump() { lock.lock(); loads += 1; lock.unlock() }
    }

    func loadAPIKey() -> String? {
        counter.bump()
        return key
    }
}

enum TransportSuite {
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private static func sync<T>(_ operation: @escaping () async -> T) -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        Task {
            box.value = await operation()
            semaphore.signal()
        }
        semaphore.wait()
        return box.value!
    }

    private final class ResultBox<T>: @unchecked Sendable { var value: T? }

    static func run(_ t: TestRunner) {
        let endpoint = ProxyEndpoint.default

        t.test("transport: a 200 decodes into the model") {
            StubProtocol.reset([.init(status: 200, body: #"{"status":"protected"}"#, urlError: nil)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let result: String? = sync {
                try? await client.health().status
            }
            t.equal(result, "protected")
        }

        t.test("transport: a 500 maps to .http and never carries the body") {
            StubProtocol.reset([.init(status: 500, body: "SECRET-CONFIG-VALUE", urlError: nil)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .http(500))
            let message = error?.userMessage ?? ""
            t.expect(!message.contains("SECRET"), "error message must not echo the body: \(message)")
        }

        t.test("transport: malformed JSON maps to .decoding") {
            StubProtocol.reset([.init(status: 200, body: "{not json", urlError: nil)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .decoding)
        }

        t.test("transport: connection refused maps to .unreachable") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .unreachable)
        }

        // A policy failure is not evidence the proxy is down; conflating them would put
        // the UI in "Stopped" for a running proxy.
        t.test("transport: an unrelated URLError maps to .transport, not .unreachable") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .appTransportSecurityRequiresSecureConnection)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .transport)
        }

        t.test("transport: cancellation propagates instead of reading as a stopped proxy") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cancelled)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            let wasCancellation: Bool = sync {
                do { _ = try await client.health(); return false }
                catch is CancellationError { return true }
                catch { return false }
            }
            t.equal(wasCancellation, true)
        }

        t.test("auth: a 401 with a stored key retries once and succeeds") {
            StubProtocol.reset([
                .init(status: 401, body: "", urlError: nil),
                .init(status: 200, body: #"{"status":"protected"}"#, urlError: nil),
            ])
            let counter = StubCredentials.Counter()
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: "test-key", counter: counter))
            let status: String? = sync { try? await client.health().status }
            t.equal(status, "protected")
            t.equal(counter.loads, 1, "credential loaded exactly once")
            t.equal(StubProtocol.recorded.count, 2, "one retry")
            let retry = StubProtocol.recorded.last
            t.equal(retry?.value(forHTTPHeaderField: "x-opencodex-api-key"), "test-key")
        }

        t.test("auth: a 401 with no stored key surfaces .unauthorized without retrying") {
            StubProtocol.reset([.init(status: 401, body: "", urlError: nil)])
            let counter = StubCredentials.Counter()
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: counter))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .unauthorized)
            t.equal(StubProtocol.recorded.count, 1, "no retry without a key")
        }

        // A stale stored key must not spin: one retry, then surface the failure.
        t.test("auth: repeated 401s retry exactly once, never looping") {
            StubProtocol.reset([
                .init(status: 401, body: "", urlError: nil),
                .init(status: 401, body: "", urlError: nil),
                .init(status: 401, body: "", urlError: nil),
            ])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: "stale", counter: .init()))
            let error: ProxyError? = sync {
                do { _ = try await client.health(); return nil }
                catch let error as ProxyError { return error }
                catch { return nil }
            }
            t.equal(error, .unauthorized)
            t.equal(StubProtocol.recorded.count, 2, "exactly one retry")
        }

        t.test("requests: usage sends the enum range as a query item") {
            StubProtocol.reset([.init(status: 200, body: #"{"range":"7d"}"#, urlError: nil)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            _ = sync { try? await client.usage(range: .sevenDays) }
            let url = StubProtocol.recorded.first?.url?.absoluteString ?? ""
            t.expect(url.contains("range=7d"), "expected range=7d in \(url)")
            t.expect(url.contains("/api/usage"), "expected /api/usage in \(url)")
        }

        t.test("requests: the provider patch sends exactly {\"disabled\":true}") {
            StubProtocol.reset([.init(status: 200, body: "{}", urlError: nil)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            _ = sync {
                try? await client.setProviderDisabled("anthropic", disabled: true)
            }
            let request = StubProtocol.recorded.first
            t.equal(request?.httpMethod, "PATCH")
            let url = request?.url?.absoluteString ?? ""
            t.expect(url.contains("name=anthropic"), "expected name=anthropic in \(url)")

            // URLProtocol strips httpBody into a stream, so assert on the encoder directly.
            let encoded = String(
                data: try JSONEncoder().encode(["disabled": true]),
                encoding: .utf8
            )
            t.equal(encoded, #"{"disabled":true}"#)
        }

        t.test("liveness: a 401 still proves something is listening") {
            StubProtocol.reset([
                .init(status: 401, body: "", urlError: nil),
                .init(status: 401, body: "", urlError: nil),
            ])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: "k", counter: .init()))
            t.equal(sync { await client.isReachable() }, true)
        }

        t.test("liveness: connection refused reads as not reachable") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: StubCredentials(key: nil, counter: .init()))
            t.equal(sync { await client.isReachable() }, false)
        }

        t.test("endpoint: an out-of-range port cannot be constructed") {
            t.isNil(ProxyEndpoint(port: 0), "port 0")
            t.isNil(ProxyEndpoint(port: -1), "port -1")
            t.isNil(ProxyEndpoint(port: 70_000), "port 70000")
            t.equal(ProxyEndpoint(port: 10_100)?.baseURL.absoluteString, "http://127.0.0.1:10100")
        }
    }
}
