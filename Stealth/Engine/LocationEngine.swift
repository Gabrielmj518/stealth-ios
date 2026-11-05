import Foundation
import idevice

/// A failure with a human readable step and the raw reason coming from the idevice library.
struct EngineFailure: LocalizedError {
    let step: String
    let detail: String
    var errorDescription: String? { detail.isEmpty ? step : "\(step) [\(detail)]" }
}

/// Talks to Apple's DVT "location simulation" service through the on-device developer
/// tunnel (LocalDevVPN, default 10.7.0.1) using the idevice library.
///
/// Call sequence: pairing file -> RPPairing tunnel -> RSD handshake -> remote server -> location simulation.
final class LocationEngine {
    static let shared = LocationEngine()
    static let defaultIP = "10.7.0.1"
    private static let tunnelPort: UInt16 = 49152

    private let queue = DispatchQueue(label: "com.stealth.engine", qos: .userInitiated)
    private var adapter: OpaquePointer?
    private var handshake: OpaquePointer?
    private var remote: OpaquePointer?
    private var sim: OpaquePointer?

    var isActive: Bool { queue.sync { sim != nil } }

    // MARK: public async API

    func set(latitude: Double, longitude: Double, pairingPath: String, classicPath: String?, ip: String) async -> EngineFailure? {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.setLocked(latitude, longitude, pairingPath, classicPath, ip))
            }
        }
    }

    func clear(pairingPath: String, classicPath: String?, ip: String) async -> EngineFailure? {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.clearLocked(pairingPath, classicPath, ip))
            }
        }
    }

    // MARK: internals (always on `queue`)

    private func describe(_ error: UnsafeMutablePointer<IdeviceFfiError>) -> String {
        let message = error.pointee.message.map { String(cString: $0) } ?? ""
        let code = error.pointee.code
        idevice_error_free(error)
        return message.isEmpty ? "code \(code)" : "code \(code): \(message)"
    }

    private func teardown() {
        if let sim { location_simulation_free(sim) }
        // The location simulation handle borrows the remote server, which is therefore
        // intentionally not freed here (it is released when the app exits).
        if let handshake { rsd_handshake_free(handshake) }
        if let adapter { adapter_free(adapter) }
        sim = nil; remote = nil; handshake = nil; adapter = nil
    }

    private var lastGood: (ip: String, port: UInt16)?

    private func makeAddress(_ ip: String, _ port: UInt16) -> sockaddr_in? {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        guard inet_pton(AF_INET, ip, &address.sin_addr) == 1 else { return nil }
        return address
    }

    /// Returns nil on success, or the error text.
    private func openTunnel(_ pairing: OpaquePointer, _ ip: String, _ port: UInt16) -> String? {
        guard var address = makeAddress(ip, port) else { return "invalid IP \(ip)" }
        let tunnelError = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPointer in
                tunnel_create_rppairing(sockPointer,
                                        socklen_t(MemoryLayout<sockaddr_in>.size),
                                        "Stealth",
                                        pairing,
                                        nil,
                                        nil,
                                        &adapter,
                                        &handshake)
            }
        }
        if let e = tunnelError {
            let d = describe(e); teardown()
            return d
        }
        return nil
    }

    /// Classic route (same as StikDebug / Locus): lockdown (port 62078) -> CoreDeviceProxy -> RSD.
    /// It goes through LocalDevVPN only, so it works with mobile data and without Wi-Fi.
    /// Returns nil on success, or the error text.
    private func openClassic(_ path: String, _ ip: String) -> String? {
        guard var address = makeAddress(ip, 62078) else { return "invalid IP \(ip)" }

        var pairing: OpaquePointer?
        if let e = idevice_pairing_file_read(path, &pairing) { return "pairing: " + describe(e) }
        guard let pairing else { return "pairing: empty handle" }

        var provider: OpaquePointer?
        let providerError = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPointer in
                idevice_tcp_provider_new(sockPointer, pairing, "Stealth", &provider)
            }
        }
        if let e = providerError { idevice_pairing_file_free(pairing); return "provider: " + describe(e) }

        var proxy: OpaquePointer?
        let proxyError = core_device_proxy_connect(provider, &proxy)
        idevice_provider_free(provider)
        if let e = proxyError { return "lockdown/proxy: " + describe(e) }

        var rsdPort: UInt16 = 0
        if let e = core_device_proxy_get_server_rsd_port(proxy, &rsdPort) {
            core_device_proxy_free(proxy); return "rsd port: " + describe(e)
        }

        var newAdapter: OpaquePointer?
        if let e = core_device_proxy_create_tcp_adapter(proxy, &newAdapter) { return "adapter: " + describe(e) }   // consumes `proxy`

        var stream: OpaquePointer?
        if let e = adapter_connect(newAdapter, rsdPort, &stream) {
            adapter_free(newAdapter); return "rsd connect: " + describe(e)
        }
        var newHandshake: OpaquePointer?
        if let e = rsd_handshake_new(stream, &newHandshake) {
            adapter_free(newAdapter); return "rsd handshake: " + describe(e)
        }
        adapter = newAdapter
        handshake = newHandshake
        return nil
    }

    private func openLocked(_ pairingPath: String, _ classicPath: String?, _ ip: String) -> EngineFailure? {
        guard makeAddress(ip, Self.tunnelPort) != nil else {
            return EngineFailure(step: "The tunnel IP is not valid", detail: ip)
        }

        var connected = false
        var log: [String] = []

        // A. Classic pairing file: works with mobile data (LocalDevVPN only).
        if let classicPath {
            if let err = openClassic(classicPath, ip) { log.append("classic -> \(err)"); teardown() }
            else { connected = true }
        }

        // B. RPPairing file (needs Wi-Fi): only if the classic route is missing or failed.
        if !connected, FileManager.default.fileExists(atPath: pairingPath) {
            var pairing: OpaquePointer?
            if let e = rp_pairing_file_read(pairingPath, &pairing) {
                log.append("rp file -> " + describe(e))
            } else if let pairing {
                defer { rp_pairing_file_free(pairing) }

                // 1. The address that worked last time.
                if let good = lastGood {
                    if let err = openTunnel(pairing, good.ip, good.port) { log.append("\(good.ip):\(good.port) -> \(err)") }
                    else { connected = true }
                }

                // 2. Discover the real port with Bonjour, then fall back to the old fixed port.
                if !connected {
                    let found = PortDiscovery.find()
                    var candidates: [(String, UInt16)] = []
                    var seen = Set<String>()
                    func add(_ host: String, _ port: UInt16) {
                        if seen.insert("\(host):\(port)").inserted { candidates.append((host, port)) }
                    }
                    for f in found {
                        add(ip, f.port)
                        if let h = f.host { add(h, f.port) }
                    }
                    add(ip, Self.tunnelPort)
                    log.append("found services: " + (found.isEmpty ? "none" : found.map { "\($0.host ?? "?"):\($0.port)" }.joined(separator: ", ")))

                    for (host, port) in candidates {
                        if let err = openTunnel(pairing, host, port) {
                            log.append("\(host):\(port) -> \(err)")
                        } else {
                            lastGood = (host, port)
                            connected = true
                            break
                        }
                    }
                }
            }
        }

        if !connected {
            lastGood = nil
            let hint = classicPath == nil
                ? "Import the classic pairing file (the .mobiledevicepairing / pairing .plist from idevice_pair) to work without Wi-Fi. "
                : ""
            return EngineFailure(step: hint + "Could not open the developer tunnel. Is LocalDevVPN connected and Developer Mode on?",
                                 detail: log.joined(separator: " | "))
        }
        if let e = remote_server_connect_rsd(adapter, handshake, &remote) {
            let d = describe(e); teardown()
            return EngineFailure(step: "Connected to the tunnel but the developer handshake failed", detail: d)
        }
        if let e = location_simulation_new(remote, &sim) {
            let d = describe(e); teardown()
            return EngineFailure(step: "Could not open Apple's location simulation service", detail: d)
        }
        return nil
    }

    private func setLocked(_ lat: Double, _ lon: Double, _ pairingPath: String, _ classicPath: String?, _ ip: String) -> EngineFailure? {
        if let sim {
            if let e = location_simulation_set(sim, lat, lon) {
                _ = describe(e)      // stale session: drop it and reconnect below
                teardown()
            } else {
                return nil
            }
        }
        if let failure = openLocked(pairingPath, classicPath, ip) { return failure }
        if let e = location_simulation_set(sim, lat, lon) {
            let d = describe(e); teardown()
            return EngineFailure(step: "Failed to set the simulated coordinates", detail: d)
        }
        return nil
    }

    private func clearLocked(_ pairingPath: String, _ classicPath: String?, _ ip: String) -> EngineFailure? {
        if sim == nil, let failure = openLocked(pairingPath, classicPath, ip) { return failure }
        var failure: EngineFailure?
        if let e = location_simulation_clear(sim) {
            failure = EngineFailure(step: "Failed to restore the real location", detail: describe(e))
        }
        teardown()
        return failure
    }
}
