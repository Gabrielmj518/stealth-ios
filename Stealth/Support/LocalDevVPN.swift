import Darwin
import UIKit

enum LocalDevVPN {
    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6755608044")!
    /// Starts the tunnel and returns to Stealth through the stealth:// scheme.
    static let enableURL = URL(string: "localdevvpn://enable?scheme=stealth")!

    static var isInstalled: Bool { UIApplication.shared.canOpenURL(URL(string: "localdevvpn://")!) }

    /// LocalDevVPN adds a 10.7.x.x address to a utun interface while it is connected
    /// (newer versions use 10.7.1.1 for the tunnel, older ones 10.7.0.x).
    static func isConnected(ip: String) -> Bool {
        return ipv4Addresses().contains { $0 == ip || $0.hasPrefix("10.7.") }
    }

    static func openOrInstall() {
        UIApplication.shared.open(isInstalled ? enableURL : appStoreURL)
    }

    private static func ipv4Addresses() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var out: [String] = []
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            let ifa = cur.pointee
            if let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    out.append(String(cString: host))
                }
            }
            ptr = ifa.ifa_next
        }
        return out
    }
}
