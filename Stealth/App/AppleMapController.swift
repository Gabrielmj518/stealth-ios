import UIKit
import MapKit
import WebKit

/// Web view that lets touches fall through to the map underneath, except on the regions
/// the page reports as interactive (buttons, panels, the simulation bar...).
final class PassthroughWebView: WKWebView {
    var passthrough = false
    var regions: [CGRect] = []

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if passthrough && !regions.contains(where: { $0.insetBy(dx: -6, dy: -6).contains(point) }) {
            return nil
        }
        return super.hitTest(point, with: event)
    }
}

/// Native Apple Maps (MKMapView) shown *behind* the transparent web page. The page keeps all the
/// UI; this class only draws the map, reports the camera and projects the markers' positions.
/// Everything is optional: if the page never asks for it, nothing here runs.
final class AppleMapController: NSObject, MKMapViewDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
    weak var container: UIView?
    weak var web: PassthroughWebView?

    private var map: MKMapView?
    private var tracked: [String: CLLocationCoordinate2D] = [:]
    private var polylines: [String: MKPolyline] = [:]
    private var polyStyles: [ObjectIdentifier: PolyStyle] = [:]
    private var framePending = false
    private let worldWidth = MKMapSize.world.width

    private struct PolyStyle {
        var color: UIColor
        var width: CGFloat
        var alpha: CGFloat
        var dash: [NSNumber]?
    }

    // MARK: messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        switch op {
        case "init":
            let lat = (body["lat"] as? Double) ?? 37.5
            let lng = (body["lng"] as? Double) ?? -96
            let zoom = (body["zoom"] as? Double) ?? 4
            attach(CLLocationCoordinate2D(latitude: lat, longitude: lng), zoom)
        case "cam":
            guard let lat = body["lat"] as? Double, let lng = body["lng"] as? Double else { return }
            let zoom = (body["zoom"] as? Double) ?? currentZoom()
            setCamera(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), zoom: zoom,
                      heading: nil, pitch: nil, animated: (body["anim"] as? Bool) ?? true)
        case "zoomBy":
            guard let m = map else { return }
            setCamera(center: m.camera.centerCoordinate, zoom: currentZoom() + ((body["d"] as? Double) ?? 1),
                      heading: nil, pitch: nil, animated: true)
        case "tilt":
            guard let m = map else { return }
            let cam = m.camera
            let pitch: CGFloat = cam.pitch < 5 ? 60 : 0
            m.setCamera(MKMapCamera(lookingAtCenter: cam.centerCoordinate, fromDistance: cam.centerCoordinateDistance,
                                    pitch: pitch, heading: cam.heading), animated: true)
        case "north":
            guard let m = map else { return }
            let cam = m.camera
            m.setCamera(MKMapCamera(lookingAtCenter: cam.centerCoordinate, fromDistance: cam.centerCoordinateDistance,
                                    pitch: 0, heading: 0), animated: true)
        case "style":
            applyStyle((body["kind"] as? String) ?? "standard")
        case "track":
            guard let id = body["id"] as? String, let lat = body["lat"] as? Double, let lng = body["lng"] as? Double else { return }
            tracked[id] = CLLocationCoordinate2D(latitude: lat, longitude: lng)
            scheduleFrame()
        case "untrack":
            if let id = body["id"] as? String { tracked.removeValue(forKey: id) }
        case "poly":
            setPolyline(body)
        case "polyRm":
            if let id = body["id"] as? String { removePolyline(id) }
        case "rects":
            guard let list = body["r"] as? [[Double]] else { return }
            let rects = list.compactMap { $0.count >= 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
            web?.regions = rects
            // Only start letting touches through once the page has told us where its buttons are.
            if !rects.isEmpty { web?.passthrough = true }
        default:
            break
        }
    }

    // MARK: map setup

    private func attach(_ center: CLLocationCoordinate2D, _ zoom: Double) {
        if let m = map {
            // The page was reloaded (iOS can do that after a long time): keep the map, reset what the old page owned.
            tracked.removeAll()
            m.removeOverlays(m.overlays)
            polylines.removeAll()
            polyStyles.removeAll()
            web?.regions = []
            web?.passthrough = false
            setCamera(center: center, zoom: zoom, heading: nil, pitch: nil, animated: false)
            send(["t": "ready"])
            scheduleFrame()
            return
        }
        guard let container, let web else { send(["t": "fail"]); return }
        let m = MKMapView(frame: container.bounds)
        m.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        m.delegate = self
        m.showsCompass = false
        m.showsScale = false
        m.showsUserLocation = false
        m.isRotateEnabled = true
        m.isPitchEnabled = true
        m.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .realistic)
        m.overrideUserInterfaceStyle = .light
        container.insertSubview(m, belowSubview: web)
        map = m

        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        let dbl = UITapGestureRecognizer(target: self, action: #selector(ignoredTap))
        dbl.numberOfTapsRequired = 2
        dbl.delegate = self
        m.addGestureRecognizer(dbl)
        m.addGestureRecognizer(tap)
        tap.require(toFail: dbl)

        container.layoutIfNeeded()
        setCamera(center: center, zoom: zoom, heading: 0, pitch: 0, animated: false)
        send(["t": "ready"])
        scheduleFrame()
    }

    @objc private func ignoredTap() {}

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard g.state == .ended, let m = map else { return }
        let c = m.convert(g.location(in: m), toCoordinateFrom: m)
        guard CLLocationCoordinate2DIsValid(c) else { return }
        send(["t": "click", "lat": c.latitude, "lng": c.longitude])
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    // MARK: camera

    private func currentZoom() -> Double {
        guard let m = map, m.bounds.width > 0 else { return 4 }
        let w = m.visibleMapRect.size.width
        guard w > 0 else { return 4 }
        let z = log2(worldWidth * Double(m.bounds.width) / (256 * w))
        return z.isFinite ? z : 4
    }

    private func setCamera(center: CLLocationCoordinate2D, zoom: Double, heading: CLLocationDirection?, pitch: CGFloat?, animated: Bool) {
        guard let m = map, m.bounds.width > 0, CLLocationCoordinate2DIsValid(center) else { return }
        let z = min(max(zoom, 2), 20)
        let targetWidth = worldWidth * Double(m.bounds.width) / (256 * pow(2, z))
        let curWidth = m.visibleMapRect.size.width
        let cam = m.camera
        var distance = curWidth > 0 ? cam.centerCoordinateDistance * targetWidth / curWidth : cam.centerCoordinateDistance
        if !distance.isFinite { return }
        distance = min(max(distance, 120), 6.0e7)
        m.setCamera(MKMapCamera(lookingAtCenter: center, fromDistance: distance,
                                pitch: pitch ?? cam.pitch, heading: heading ?? cam.heading), animated: animated)
    }

    private func applyStyle(_ kind: String) {
        guard let m = map else { return }
        switch kind {
        case "sat":
            m.preferredConfiguration = MKHybridMapConfiguration(elevationStyle: .realistic)
            m.overrideUserInterfaceStyle = .dark
        case "dark":
            m.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .realistic)
            m.overrideUserInterfaceStyle = .dark
        case "darknl":
            let c = MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .muted)
            c.pointOfInterestFilter = .excludingAll
            m.preferredConfiguration = c
            m.overrideUserInterfaceStyle = .dark
        case "light":
            m.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .muted)
            m.overrideUserInterfaceStyle = .light
        default:
            m.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .realistic)
            m.overrideUserInterfaceStyle = .light
        }
    }

    // MARK: lines

    private func setPolyline(_ b: [String: Any]) {
        guard let m = map, let id = b["id"] as? String, let pts = b["pts"] as? [[Double]] else { return }
        removePolyline(id)
        let coords = pts.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) : nil }
        guard coords.count > 1 else { return }
        let line = MKPolyline(coordinates: coords, count: coords.count)
        var dash: [NSNumber]?
        if let d = b["dash"] as? [Double], !d.isEmpty { dash = d.map { NSNumber(value: $0) } }
        polyStyles[ObjectIdentifier(line)] = PolyStyle(
            color: Self.color(b["color"] as? String),
            width: CGFloat((b["w"] as? Double) ?? 3),
            alpha: CGFloat((b["a"] as? Double) ?? 1),
            dash: dash)
        polylines[id] = line
        m.addOverlay(line)
    }

    private func removePolyline(_ id: String) {
        guard let line = polylines.removeValue(forKey: id) else { return }
        polyStyles.removeValue(forKey: ObjectIdentifier(line))
        map?.removeOverlay(line)
    }

    private static func color(_ text: String?) -> UIColor {
        guard var s = text?.trimmingCharacters(in: .whitespaces), s.hasPrefix("#") else { return UIColor(red: 0.29, green: 0.64, blue: 1, alpha: 1) }
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return UIColor(red: 0.29, green: 0.64, blue: 1, alpha: 1) }
        return UIColor(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        guard let line = overlay as? MKPolyline, let st = polyStyles[ObjectIdentifier(line)] else {
            return MKOverlayRenderer(overlay: overlay)
        }
        let r = MKPolylineRenderer(polyline: line)
        r.strokeColor = st.color.withAlphaComponent(st.alpha)
        r.lineWidth = st.width
        r.lineCap = .round
        r.lineJoin = .round
        if let d = st.dash { r.lineDashPattern = d }
        return r
    }

    // MARK: camera events back to the page

    func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) { scheduleFrame() }
    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) { scheduleFrame() }

    private func scheduleFrame() {
        guard !framePending else { return }
        framePending = true
        DispatchQueue.main.async { [weak self] in
            self?.framePending = false
            self?.sendFrame()
        }
    }

    private func fin(_ v: Double) -> Double { v.isFinite ? v : 0 }

    private func sendFrame() {
        guard let m = map else { return }
        let cam = m.camera
        var points: [[Any]] = []
        for (id, c) in tracked {
            let p = m.convert(c, toPointTo: m)
            points.append([id, fin(Double(p.x)), fin(Double(p.y))])
        }
        send(["t": "frame",
              "lat": fin(cam.centerCoordinate.latitude), "lng": fin(cam.centerCoordinate.longitude),
              "z": fin(currentZoom()), "hd": fin(cam.heading), "pt": fin(Double(cam.pitch)),
              "p": points])
    }

    private func send(_ event: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.__am && window.__am.ev(\(json))", completionHandler: nil)
    }
}
