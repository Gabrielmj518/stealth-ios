import Foundation
import UIKit
import UserNotifications
import idevice

/// iOS 27+: pairs this iPhone with itself, with no computer.
///
/// Stealth publishes itself as a "pairable host" through the system Bonjour service. The
/// user then picks it in Settings > Privacy & Security > Developer Mode > Pair with Host
/// and types the 6-digit code shown by Stealth. The resulting RPPairing file is saved in
/// the app's private storage, exactly like an imported one.
final class OnDevicePairing: NSObject, NetServiceDelegate {
    static let shared = OnDevicePairing()
    static let serviceType = "_remotepairing-pairable-host._tcp."

    /// Called on the main thread with the 6-digit code to show.
    var onPin: ((String) -> Void)?
    /// Called on the main thread when pairing ends. `nil` means success.
    var onFinish: ((String?) -> Void)?

    private(set) var isRunning = false
    private var cancelToken: OpaquePointer?
    private var service: NetService?
    private var background: UIBackgroundTaskIdentifier = .invalid
    private let queue = DispatchQueue(label: "com.stealth.pairing", qos: .userInitiated)

    static var isSupported: Bool { ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27 }

    // MARK: control

    func start(store: PairingStore) {
        guard !isRunning else { return }
        isRunning = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        background = UIApplication.shared.beginBackgroundTask(withName: "stealth-pairing") { [weak self] in self?.cancel() }

        let token = pairable_host_cancel_new()
        cancelToken = token
        let me = Unmanaged.passUnretained(self).toOpaque()
        store.ensureDirectory()
        let path = store.path

        queue.async {
            var handle: OpaquePointer?
            var failure: String?
            if let e = stealth_pairable_host_accept("Stealth", "Mac17,7", 0, advertiseCallback, pinCallback, me, token, &handle) {
                failure = describePairingError(e)
            } else if let handle {
                if let e = rp_pairing_file_write(handle, path) { failure = "Could not save the pairing file [\(describePairingError(e))]" }
                rp_pairing_file_free(handle)
            } else {
                failure = "No pairing file was produced"
            }
            if let token { pairable_host_cancel_free(token) }
            DispatchQueue.main.async { self.finish(failure) }
        }
    }

    func cancel() {
        if let token = cancelToken { pairable_host_cancel_signal(token) }
    }

    // MARK: called from the C callbacks (main thread)

    fileprivate func publish(port: UInt16, identifier: String, txt: String) {
        var records: [String: Data] = [:]
        for line in txt.split(separator: "\n") {
            guard let eq = line.firstIndex(of: "=") else { continue }
            records[String(line[..<eq])] = Data(line[line.index(after: eq)...].utf8)
        }
        service?.stop()
        let svc = NetService(domain: "local.", type: Self.serviceType, name: identifier, port: Int32(port))
        svc.delegate = self
        svc.setTXTRecord(NetService.data(fromTXTRecord: records))
        svc.publish()
        service = svc
    }

    fileprivate func showPin(_ pin: String) {
        onPin?(pin)
        let content = UNMutableNotificationContent()
        let spanish = Locale.preferredLanguages.first?.hasPrefix("es") ?? false
        content.title = spanish ? "Código de emparejamiento: \(pin)" : "Pairing code: \(pin)"
        content.body = spanish ? "Escríbelo en Ajustes para terminar de emparejar Stealth." : "Type it in Settings to finish pairing Stealth."
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "stealth-pin", content: content, trigger: nil))
    }

    private func finish(_ failure: String?) {
        service?.stop(); service = nil
        cancelToken = nil
        isRunning = false
        if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["stealth-pin"])
        onFinish?(failure)
    }

    // MARK: NetServiceDelegate

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        cancel()
        DispatchQueue.main.async {
            self.onFinish?("Could not announce Stealth to Settings. Allow Local Network for Stealth (Settings → Stealth) and try again. \(errorDict)")
        }
    }
}

private func describePairingError(_ error: UnsafeMutablePointer<IdeviceFfiError>) -> String {
    let message = error.pointee.message.map { String(cString: $0) } ?? ""
    let code = error.pointee.code
    idevice_error_free(error)
    return message.isEmpty ? "code \(code)" : "code \(code): \(message)"
}

private let advertiseCallback: @convention(c) (UInt16, UnsafePointer<CChar>?, UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void = { port, identifier, txt, context in
    guard let context, let identifier, let txt else { return }
    let me = Unmanaged<OnDevicePairing>.fromOpaque(context).takeUnretainedValue()
    let id = String(cString: identifier), text = String(cString: txt)
    DispatchQueue.main.async { me.publish(port: port, identifier: id, txt: text) }
}

private let pinCallback: @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void = { pin, context in
    guard let context, let pin else { return }
    let me = Unmanaged<OnDevicePairing>.fromOpaque(context).takeUnretainedValue()
    let code = String(cString: pin)
    DispatchQueue.main.async { me.showPin(code) }
}
