import CoreLocation
import UIKit

/// Keeps the app alive in the background while a location is being simulated, and
/// remembers the last real fix so the "where am I" button works after Stop.
final class KeepAlive: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var last: CLLocationCoordinate2D?
    private var running = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = false
    }

    func start() {
        guard !running else { return }
        running = true
        manager.requestWhenInUseAuthorization()
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = false
        manager.startUpdatingLocation()
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        last = locations.last?.coordinate
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if running { manager.startUpdatingLocation() }
    }
}
