import SwiftUI
import WebKit

@main
struct StealthApp: App {
    init() { SimNotifier.shared.setup() }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @StateObject private var bridge = Bridge()

    var body: some View {
        ZStack {
            Color(red: 0.078, green: 0.078, blue: 0.078).ignoresSafeArea()
            WebHost(bridge: bridge).ignoresSafeArea()
        }
    }
}

struct WebHost: UIViewRepresentable {
    let bridge: Bridge

    func makeUIView(context: Context) -> UIView {
        let bg = UIColor(red: 0.078, green: 0.078, blue: 0.078, alpha: 1)
        let container = UIView()
        container.backgroundColor = bg

        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakScriptHandler(bridge), name: "stealth")
        config.userContentController.add(WeakScriptHandler(bridge.appleMap), name: "applemap")
        config.allowsInlineMediaPlayback = true

        let web = PassthroughWebView(frame: container.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.uiDelegate = bridge
        web.navigationDelegate = bridge
        web.isOpaque = false
        web.backgroundColor = bg
        web.scrollView.backgroundColor = bg
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.scrollView.showsVerticalScrollIndicator = false
        web.allowsLinkPreview = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        container.addSubview(web)
        bridge.webView = web
        bridge.appleMap.container = container
        bridge.appleMap.web = web

        if let dir = Bundle.main.url(forResource: "Web", withExtension: nil) {
            web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        } else {
            web.loadHTMLString("<body style='background:#141414;color:#fff;font:16px -apple-system'>Web resources are missing from the app bundle.</body>", baseURL: nil)
        }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
