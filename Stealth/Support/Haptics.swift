import UIKit

/// Small vibration feedback for teleport, stop and errors.
enum Haptics {
    static func play(_ kind: String) {
        switch kind {
        case "ok":   UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "err":  UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "stop": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default:     UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
