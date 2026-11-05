import Foundation
import UIKit
import UniformTypeIdentifiers

enum PairingError: LocalizedError {
    case emptyClipboard, invalid
    var errorDescription: String? {
        switch self {
        case .emptyClipboard: return "The clipboard is empty. Copy the pairing file contents (or the file) and try again."
        case .invalid: return "That does not look like a pairing (.plist) file."
        }
    }
}

/// Keeps the RPPairing file inside the app's private storage.
final class PairingStore {
    private var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Pairing", isDirectory: true)
    }
    /// RPPairing file (needs Wi-Fi to open the tunnel).
    var url: URL { directory.appendingPathComponent("rp_pairing_file.plist") }
    var path: String { url.path }
    var hasRP: Bool { FileManager.default.fileExists(atPath: url.path) }
    /// Classic pairing file (works over LocalDevVPN with mobile data, no Wi-Fi needed).
    var classicURL: URL { directory.appendingPathComponent("pairing_file.plist") }
    var classicPath: String? { hasClassic ? classicURL.path : nil }
    var hasClassic: Bool { FileManager.default.fileExists(atPath: classicURL.path) }
    var hasFile: Bool { hasRP || hasClassic }

    func ensureDirectory() { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }

    func importFile(at source: URL) throws {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        try install(try Data(contentsOf: source))
    }

    func importFromClipboard() throws {
        let board = UIPasteboard.general
        if let u = board.url, u.isFileURL { try importFile(at: u); return }
        let candidates: [Data?] = [
            board.data(forPasteboardType: "com.apple.property-list"),
            board.data(forPasteboardType: UTType.propertyList.identifier),
            board.data(forPasteboardType: UTType.xml.identifier),
            board.data(forPasteboardType: UTType.data.identifier),
            board.string?.data(using: .utf8)
        ]
        guard let data = candidates.compactMap({ $0 }).first(where: { !$0.isEmpty }) else { throw PairingError.emptyClipboard }
        try install(data)
    }

    func remove() {
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.removeItem(at: classicURL)
    }

    /// A classic (lockdown) pairing file has these keys; an RPPairing file does not.
    private func isClassic(_ data: Data) -> Bool {
        guard let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = obj as? [String: Any] else { return false }
        return dict["DeviceCertificate"] != nil && dict["HostPrivateKey"] != nil
    }

    private func install(_ data: Data) throws {
        guard looksLikePlist(data) else { throw PairingError.invalid }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = isClassic(data) ? classicURL : url
        try? FileManager.default.removeItem(at: target)
        try data.write(to: target, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    private func looksLikePlist(_ data: Data) -> Bool {
        if let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) {
            return obj is [AnyHashable: Any] || obj is [Any]
        }
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return text.hasPrefix("<?xml") || text.hasPrefix("bplist") || text.contains("<plist")
    }
}
