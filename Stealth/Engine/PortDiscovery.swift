import Foundation
import Network

/// Finds the port of the iPhone's remote pairing (developer tunnel) service through Bonjour.
/// The port is not fixed on every iOS version, so a hard-coded value can fail with
/// "connect: device socket io failed".
enum PortDiscovery {
    static let serviceTypes = ["_remotepairing._tcp", "_remotepairing-manual-pairing._tcp"]

    struct Found {
        let host: String?   // IPv4 address the service answered on (if any)
        let port: UInt16
        let type: String
    }

    /// Blocking: call from a background queue.
    static func find(timeout: TimeInterval = 4) -> [Found] {
        let queue = DispatchQueue(label: "com.stealth.discovery")
        let lock = NSLock()
        var found: [Found] = []
        var seen = Set<String>()
        var browsers: [NWBrowser] = []
        var connections: [NWConnection] = []

        for type in serviceTypes {
            let browser = NWBrowser(for: .bonjour(type: type, domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    guard case .service = result.endpoint else { continue }
                    lock.lock()
                    let isNew = seen.insert("\(result.endpoint)").inserted
                    lock.unlock()
                    guard isNew else { continue }

                    let connection = NWConnection(to: result.endpoint, using: .tcp)
                    connection.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint {
                                var h = "\(host)"
                                if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                                let isV4 = h.split(separator: ".").count == 4
                                lock.lock()
                                found.append(Found(host: isV4 ? h : nil, port: port.rawValue, type: type))
                                lock.unlock()
                            }
                            connection.cancel()
                        case .failed:
                            connection.cancel()
                        default:
                            break
                        }
                    }
                    lock.lock(); connections.append(connection); lock.unlock()
                    connection.start(queue: queue)
                }
            }
            browser.start(queue: queue)
            browsers.append(browser)
        }

        Thread.sleep(forTimeInterval: timeout)
        browsers.forEach { $0.cancel() }
        lock.lock()
        connections.forEach { $0.cancel() }
        let out = found
        lock.unlock()
        return out
    }
}
