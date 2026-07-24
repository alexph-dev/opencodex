import AppKit
import MenuBarCore

// Phase 1 entry point: registers a status item so the executable is launchable and
// verifiable via `swift run`. The popover UI lands in Phase 2 (020).

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate
app.run()

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "ocx"
        item.button?.toolTip = "OpenCodex"

        let endpoint = ProxyDiscovery.resolve()
        let menu = NSMenu()
        menu.addItem(
            withTitle: "Proxy: \(endpoint.display)",
            action: nil,
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "Quit OpenCodex",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        item.menu = menu
        statusItem = item
    }
}
