import Foundation

/// A loopback endpoint for the local OpenCodex proxy.
///
/// The host is deliberately fixed to loopback and never read from disk: the port record
/// is a convenience, not a redirection mechanism.
public struct ProxyEndpoint: Equatable, Sendable {
    public static let loopbackHost = "127.0.0.1"

    public let host: String
    public let port: Int

    public init(port: Int) {
        self.host = Self.loopbackHost
        self.port = port
    }

    public var baseURL: URL {
        // Safe: host is a fixed literal and port is range-checked at construction sites.
        URL(string: "http://\(host):\(port)")!
    }

    public var display: String { "\(host):\(port)" }
}

struct RuntimePortRecord: Decodable {
    let pid: Int?
    let port: Int
}

/// Resolves where the proxy is listening, mirroring `resolveRuntimePortPath()` in
/// `src/config.ts`.
public enum ProxyDiscovery {
    public static let defaultPort = 10100
    public static let validPorts = 1...65535

    /// `OPENCODEX_HOME` when set and non-empty, else `~/.opencodex`.
    public static func configDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let override = environment["OPENCODEX_HOME"]?.trimmingCharacters(in: .whitespaces),
           !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return home.appendingPathComponent(".opencodex", isDirectory: true)
    }

    /// Reads `runtime-port.json`, falling back to the default port on any problem.
    ///
    /// Every failure mode — missing file, malformed JSON, out-of-range port — resolves to
    /// the default rather than throwing. A menu bar app that refuses to start because a
    /// cache file is unreadable would be worse than one that probes the usual port.
    public static func resolve(configDirectory directory: URL) -> ProxyEndpoint {
        let file = directory.appendingPathComponent("runtime-port.json")
        guard
            let data = try? Data(contentsOf: file),
            let record = try? JSONDecoder().decode(RuntimePortRecord.self, from: data),
            validPorts.contains(record.port)
        else {
            return ProxyEndpoint(port: defaultPort)
        }
        return ProxyEndpoint(port: record.port)
    }

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> ProxyEndpoint {
        resolve(configDirectory: configDirectory(environment: environment, home: home))
    }
}
