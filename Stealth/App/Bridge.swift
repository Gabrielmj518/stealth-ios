import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Connects the web interface (window.stealth.*) with the native engine.
final class Bridge: NSObject, ObservableObject, WKScriptMessageHandler, WKUIDelegate, UIDocumentPickerDelegate {
    weak var webView: WKWebView?
    private let pairing = PairingStore()
    private let keepAlive = KeepAlive()
    private var pickerDone: (([String: Any]) -> Void)?

    private var tunnelIP: String { LocationEngine.defaultIP }

    // MARK: messages from JavaScript

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let cmd = body["cmd"] as? String else { return }
        handle(cmd, body) { [weak self] value in self?.reply(id, value) }
    }

    private func reply(_ id: Int, _ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__stealthReply(\(id), \(json))", completionHandler: nil)
        }
    }

    private func handle(_ cmd: String, _ body: [String: Any], _ done: @escaping ([String: Any]) -> Void) {
        switch cmd {
        case "requirements":
            DispatchQueue.main.async { done(self.requirements()) }

        case "set":
            guard let lat = (body["lat"] as? NSNumber)?.doubleValue,
                  let lon = (body["lon"] as? NSNumber)?.doubleValue else { return done(["ok": false, "error": "Bad coordinates"]) }
            guard pairing.hasFile else { return done(["ok": false, "error": "Import a pairing file first (tap your iPhone at the top left)."]) }
            Task {
                let failure = await LocationEngine.shared.set(latitude: lat, longitude: lon, pairingPath: self.pairing.path, ip: self.tunnelIP)
                done(failure == nil ? ["ok": true] : ["ok": false, "error": failure!.localizedDescription])
            }

        case "clear":
            guard pairing.hasFile else { return done(["ok": false, "error": "Import a pairing file first."]) }
            Task {
                let failure = await LocationEngine.shared.clear(pairingPath: self.pairing.path, ip: self.tunnelIP)
                done(failure == nil ? ["ok": true] : ["ok": false, "error": failure!.localizedDescription])
            }

        case "importPairing":
            DispatchQueue.main.async { self.presentPicker(done) }

        case "pastePairing":
            DispatchQueue.main.async {
                do { try self.pairing.importFromClipboard(); done(["ok": true]) }
                catch { done(["ok": false, "error": error.localizedDescription]) }
            }

        case "openVPN":
            DispatchQueue.main.async { LocalDevVPN.openOrInstall(); done(["ok": true]) }

        case "realLocation":
            DispatchQueue.main.async {
                self.keepAlive.start()
                if let c = self.keepAlive.last { done(["ok": true, "lat": c.latitude, "lon": c.longitude]) }
                else { done(["ok": false]) }
            }

        case "openExternal":
            DispatchQueue.main.async {
                if let s = body["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme ?? "") {
                    UIApplication.shared.open(u)
                }
                done(["ok": true])
            }

        case "appConfig":
            let active = (body["simActive"] as? Bool) ?? false
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = active
                if active { self.keepAlive.start() }
                done(["ok": true])
            }

        case "simNotify":
            let active = (body["active"] as? Bool) ?? false
            let start = (body["start"] as? NSNumber)?.doubleValue ?? 0
            let place = (body["place"] as? String) ?? ""
            DispatchQueue.main.async {
                SimNotifier.shared.update(active: active, startMs: start, place: place)
                done(["ok": true])
            }

        case "share":
            let name = (body["name"] as? String) ?? "stealth.txt"
            let text = (body["text"] as? String) ?? ""
            DispatchQueue.main.async {
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                try? text.write(to: url, atomically: true, encoding: .utf8)
                let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                vc.popoverPresentationController?.sourceView = self.webView
                Self.topController()?.present(vc, animated: true)
                done(["ok": true])
            }

        default:
            done(["ok": false, "error": "Unknown command"])
        }
    }

    private func requirements() -> [String: Any] {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel
        let hasPairing = pairing.hasFile
        let vpn = LocalDevVPN.isConnected(ip: tunnelIP)
        var info: [String: Any] = [
            "name": device.name,
            "version": device.systemVersion,
            "model": device.model,
            "charging": device.batteryState == .charging || device.batteryState == .full
        ]
        if level >= 0 { info["battery"] = Int((level * 100).rounded()) }
        return [
            "ok": true, "native": true,
            "pairing": hasPairing, "vpn": vpn, "vpnInstalled": LocalDevVPN.isInstalled,
            "usb": true, "admin": true, "driver": true, "python": true, "pmd3": true, "internet": true,
            "link": hasPairing && vpn,
            "device": info
        ]
    }

    // MARK: pairing file picker

    private func presentPicker(_ done: @escaping ([String: Any]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item, .data, .propertyList, .xml], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        pickerDone = done
        Self.topController()?.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { pickerDone?(["ok": false, "error": "No file selected"]); pickerDone = nil; return }
        do { try pairing.importFile(at: url); pickerDone?(["ok": true]) }
        catch { pickerDone?(["ok": false, "error": error.localizedDescription]) }
        pickerDone = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerDone?(["ok": false, "error": "Cancelled"]); pickerDone = nil
    }

    // MARK: JavaScript dialogs (alert / confirm / prompt)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        Self.topController()?.present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        Self.topController()?.present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        Self.topController()?.present(a, animated: true)
    }

    // MARK: helpers

    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        var vc = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController ?? scene?.windows.first?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }
}

/// Avoids a retain cycle between WKUserContentController and the bridge.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
