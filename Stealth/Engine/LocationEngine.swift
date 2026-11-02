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

    func set(latitude: Double, longitude: Double, pairingPath: String, ip: String) async -> EngineFailure? {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.setLocked(latitude, longitude, pairingPath, ip))
            }
        }
    }

    func clear(pairingPath: String, ip: String) async -> EngineFailure? {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.clearLocked(pairingPath, ip))
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

    private func openLocked(_ pairingPath: String, _ ip: String) -> EngineFailure? {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = Self.tunnelPort.bigEndian
        guard inet_pton(AF_INET, ip, &address.sin_addr) == 1 else {
            return EngineFailure(step: "The tunnel IP is not valid", detail: ip)
        }

        var pairing: OpaquePointer?
        if let e = rp_pairing_file_read(pairingPath, &pairing) {
            return EngineFailure(step: "Could not read the pairing file. Create an RPPairing file with idevice_pair and import it again", detail: describe(e))
        }
        guard let pairing else {
            return EngineFailure(step: "Could not read the pairing file", detail: "empty handle")
        }
        defer { rp_pairing_file_free(pairing) }

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
            return EngineFailure(step: "Could not open the developer tunnel. Is LocalDevVPN connected and Developer Mode on?", detail: d)
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

    private func setLocked(_ lat: Double, _ lon: Double, _ pairingPath: String, _ ip: String) -> EngineFailure? {
        if let sim {
            if let e = location_simulation_set(sim, lat, lon) {
                _ = describe(e)      // stale session: drop it and reconnect below
                teardown()
            } else {
                return nil
            }
        }
        if let failure = openLocked(pairingPath, ip) { return failure }
        if let e = location_simulation_set(sim, lat, lon) {
            let d = describe(e); teardown()
            return EngineFailure(step: "Failed to set the simulated coordinates", detail: d)
        }
        return nil
    }

    private func clearLocked(_ pairingPath: String, _ ip: String) -> EngineFailure? {
        if sim == nil, let failure = openLocked(pairingPath, ip) { return failure }
        var failure: EngineFailure?
        if let e = location_simulation_clear(sim) {
            failure = EngineFailure(step: "Failed to restore the real location", detail: describe(e))
        }
        teardown()
        return failure
    }
}
