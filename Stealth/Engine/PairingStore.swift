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
    var url: URL { directory.appendingPathComponent("rp_pairing_file.plist") }
    var path: String { url.path }
    var hasFile: Bool { FileManager.default.fileExists(atPath: url.path) }

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

    func remove() { try? FileManager.default.removeItem(at: url) }

    private func install(_ data: Data) throws {
        guard looksLikePlist(data) else { throw PairingError.invalid }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        try data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func looksLikePlist(_ data: Data) -> Bool {
        if let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) {
            return obj is [AnyHashable: Any] || obj is [Any]
        }
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return text.hasPrefix("<?xml") || text.hasPrefix("bplist") || text.contains("<plist")
    }
}
