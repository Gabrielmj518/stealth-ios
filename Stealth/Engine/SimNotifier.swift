import Foundation
import UIKit
import UserNotifications

/// Shows a notification when the location is changed and keeps it updated with the
/// time connected (once a minute, silently) while the simulation is active.
final class SimNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SimNotifier()

    private enum Kind { case changed, tick, stopped }

    private let center = UNUserNotificationCenter.current()
    private let identifier = "stealth-sim"
    private let spanish = Locale.preferredLanguages.first?.hasPrefix("es") ?? false
    private var timer: Timer?
    private var start: Date?
    private var place = ""

    func setup() { center.delegate = self }

    /// Called from the web interface every time the simulation state changes. Main thread.
    func update(active: Bool, startMs: Double, place newPlace: String) {
        let name = newPlace.components(separatedBy: " · ").first ?? newPlace
        if active {
            let began = Date(timeIntervalSince1970: startMs / 1000)
            let isNewSession = start == nil || abs(start!.timeIntervalSince(began)) > 1
            let placeChanged = name != place
            start = began
            place = name
            if isNewSession {
                center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
                    guard granted else { return }
                    DispatchQueue.main.async { self?.post(.changed) }
                }
                startTimer()
            } else if placeChanged {
                post(.tick)
            }
        } else if start != nil {
            timer?.invalidate(); timer = nil
            post(.stopped)
            start = nil
            place = ""
        }
    }

    private func startTimer() {
        timer?.invalidate()
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.post(.tick) }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func elapsedText() -> String {
        let seconds = Int(Date().timeIntervalSince(start ?? Date()))
        let h = seconds / 3600, m = (seconds / 60) % 60
        return h > 0 ? "\(h) h \(String(format: "%02d", m)) min" : "\(m) min"
    }

    private func clock(_ date: Date) -> String {
        let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
        return f.string(from: date)
    }

    private func post(_ kind: Kind) {
        guard let began = start else { return }
        let content = UNMutableNotificationContent()
        let where_ = place.isEmpty ? (spanish ? "Ubicación simulada" : "Simulated location") : place
        let connected = spanish ? "Tiempo conectado" : "Time connected"
        let since = spanish ? "desde las" : "since"
        switch kind {
        case .changed:
            content.title = spanish ? "📍 Ubicación cambiada" : "📍 Location changed"
            content.body = "\(where_)\n\(connected): \(elapsedText()) · \(since) \(clock(began))"
            content.sound = .default
        case .tick:
            content.title = spanish ? "📍 Ubicación simulada activa" : "📍 Simulated location active"
            content.body = "\(where_)\n\(connected): \(elapsedText()) · \(since) \(clock(began))"
            content.interruptionLevel = .passive      // silent update, no banner
        case .stopped:
            content.title = spanish ? "✅ Ubicación real restaurada" : "✅ Real location restored"
            content.body = (spanish ? "Estuviste conectado " : "You were connected for ") + elapsedText()
        }
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    // Show the "location changed" banner even while the app is open; keep updates quiet.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(notification.request.content.interruptionLevel == .passive ? [.list] : [.banner, .list, .sound])
    }
}
