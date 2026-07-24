// Visual-QA harness (not shipped).
//
// Presents the real PopoverPanel over a deliberately loud backdrop and captures it with
// CGWindowListCreateImage, so every UI state can be inspected without depending on free
// menu bar space.
//
// Two harness decisions are load-bearing, both learned the hard way:
//   * Present through the REAL panel. An earlier version used a plain NSWindow, which
//     supplied its own background and hid the fact that the panel had none at all.
//   * Capture through the window server. cacheDisplay(in:to:) skips text rendering and
//     produced screenshots with no labels.
//
// PROBE_STATE: live | stopped | unauthorized | loading | degraded | empty | overflow
// PROBE_TAG: output filename suffix
// PROBE_APPEARANCE: light | dark (forces appearance without touching system settings)

import AppKit
import MenuBarCore
import MenuBarUI

// Renders the popover in a plain window and screenshots it, so the UI can be inspected
// without depending on menu bar space being available.
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    let controller = PopoverViewController()
    var window: NSWindow?

    func applicationDidFinishLaunching(_ n: Notification) {
        // Force an appearance for contrast measurement without touching system settings.
        if let name = ProcessInfo.processInfo.environment["PROBE_APPEARANCE"] {
            NSApp.appearance = NSAppearance(named: name == "dark" ? .darkAqua : .aqua)
        }
        let endpoint = ProxyDiscovery.resolve()
        let client = ProxyClient(endpoint: endpoint)
        let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

        // A loud backdrop first: if the panel has no surface of its own, this shows
        // straight through and the defect is unmissable.
        let backdrop = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 620),
            styleMask: [.titled], backing: .buffered, defer: false)
        backdrop.title = "backdrop"
        let strip = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 620))
        strip.wantsLayer = true
        strip.layer?.backgroundColor = NSColor.systemRed.cgColor
        for i in 0..<14 {
            let bar = NSView(frame: NSRect(x: 0, y: CGFloat(i) * 44, width: 520, height: 22))
            bar.wantsLayer = true
            bar.layer?.backgroundColor = NSColor.systemYellow.cgColor
            strip.addSubview(bar)
        }
        backdrop.contentView = strip
        backdrop.center()
        backdrop.makeKeyAndOrderFront(nil)

        // Present through the real panel so its surface (or absence of one) is captured.
        let realPanel = PopoverPanel()
        realPanel.contentViewController = controller
        controller.view.layoutSubtreeIfNeeded()
        let size = controller.preferredContentSize
        realPanel.setContentSize(NSSize(width: 340, height: max(size.height, 200)))
        realPanel.setFrameOrigin(NSPoint(x: backdrop.frame.midX - 170, y: backdrop.frame.midY - 150))
        realPanel.makeKeyAndOrderFront(nil)
        window = realPanel
        NSApp.activate(ignoringOtherApps: true)

        Task {
            var snap: ProxySnapshot
            let mode = ProcessInfo.processInfo.environment["PROBE_STATE"] ?? "live"
            switch mode {
            case "stopped":
                snap = ProxySnapshot(state: .unreachable, endpoint: endpoint,
                                     lastKnownStartCommand: "ocx service start")
            case "unauthorized":
                snap = ProxySnapshot(state: .unauthorized, endpoint: endpoint)
            case "loading":
                snap = ProxySnapshot(state: .loading, endpoint: endpoint)
            case "degraded":
                snap = ProxySnapshot(state: .degraded("The proxy returned an unexpected status (503)."),
                                     endpoint: endpoint, lastUpdated: Date().addingTimeInterval(-120))
            case "overflow":
                let many = (1...24).map { i in
                    #"{"provider":"p\#(i)","label":"Provider \#(i)","quota":{"weeklyPercent":\#(i * 3)}}"#
                }.joined(separator: ",")
                let quotas = (try? JSONDecoder().decode([QuotaReport].self, from: Data("[\(many)]".utf8))) ?? []
                let usage = try? JSONDecoder().decode(
                    UsageReport.self,
                    from: Data(#"{"range":"7d","summary":{"requests":100},"days":[{"date":"d","requests":100}]}"#.utf8))
                snap = ProxySnapshot(state: .running(StartupHealth(status: "protected", protection: "service")),
                                     endpoint: endpoint, usage: usage, quotas: quotas,
                                     quotasLoaded: true)
            case "empty":
                let usage = try? JSONDecoder().decode(
                    UsageReport.self,
                    from: Data(#"{"range":"7d","summary":{"requests":0},"days":[]}"#.utf8))
                snap = ProxySnapshot(state: .running(StartupHealth(status: "protected", protection: "service")),
                                     endpoint: endpoint, usage: usage, quotas: [], providers: [],
                                     providersLoaded: true, quotasLoaded: true)
            default:
                await coordinator.setPopoverOpen(true)
                snap = await coordinator.current
            }
            await MainActor.run {
                self.controller.apply(snap)
                self.controller.view.layoutSubtreeIfNeeded()
                // Match the real popover: size to content instead of a fixed frame.
                let h = self.controller.preferredContentSize.height
                if h > 0, let w = self.window {
                    w.setContentSize(NSSize(width: 340, height: h))
                }
            }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await MainActor.run { self.capture() }
        }
    }

    @MainActor func capture() {
        guard let w = window else { return }
        let tag = ProcessInfo.processInfo.environment["PROBE_TAG"] ?? "light"
        // CGWindowListCreateImage rather than shelling out to screencapture: nothing
        // under app/ may construct a Process (030 security rule). The bitmap-rep path
        // is not an option either — it skips text rendering entirely.
        let id = CGWindowID(w.windowNumber)
        if let cg = CGWindowListCreateImage(
            .null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .bestResolution]
        ) {
            let rep = NSBitmapImageRep(cgImage: cg)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "/tmp/popover-\(tag).png"))
            }
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = ProbeDelegate()
app.delegate = d
app.run()
