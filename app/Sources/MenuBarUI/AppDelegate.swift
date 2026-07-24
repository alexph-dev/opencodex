import AppKit
import MenuBarCore

public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    /// A key-capable panel rather than `NSPopover`.
    ///
    /// This is the single most-tested decision in this file. `NSPopover` from an
    /// accessory (`LSUIElement`) process creates a window that never appears in
    /// `NSApp.windows` and reports `canBecomeKey == false`, so macOS will not route key
    /// events to it no matter how the process is activated — Escape and the Tab path
    /// simply never arrive. A `nonactivatingPanel` that overrides `canBecomeKey`
    /// measures as `canBecomeKey=1 isKey=1` under the same conditions.
    private let panel = PopoverPanel()
    private let controller = PopoverViewController()
    private var coordinator: PollingCoordinator?
    private var client: ProxyClient?
    private var endpoint = ProxyEndpoint.default
    private var pollTask: Task<Void, Never>?
    /// Fallback Escape handling for the case where the panel is visible but another
    /// process holds focus. Installed on open, removed on close.
    private var escapeMonitor: Any?

    public override init() { super.init() }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        endpoint = ProxyDiscovery.resolve()
        let client = ProxyClient(endpoint: endpoint)
        self.client = client
        let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
        self.coordinator = coordinator

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = StatusIcon.image(for: .loading)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.setAccessibilityLabel("OpenCodex proxy status")
        statusItem = item

        controller.onDashboard = { [weak self] in self?.openDashboard() }
        controller.onStop = { [weak self] in self?.stopProxy() }
        controller.onRefresh = { [weak self] in self?.refreshNow() }
        controller.onAddKey = { [weak self] in self?.openDashboard() }
        controller.onRetry = { [weak self] in self?.refreshNow() }
        controller.onQuit = { NSApp.terminate(nil) }

        panel.contentViewController = controller
        panel.onDismiss = { [weak self] in self?.handlePanelClosed() }

        // The observer closure is `@Sendable` and crosses actor boundaries, so it must
        // not capture the delegate. It hops to the main actor and looks the delegate up
        // there instead.
        Task {
            await coordinator.observe { snapshot in
                Task { @MainActor in
                    (NSApp.delegate as? AppDelegate)?.render(snapshot)
                }
            }
            await MainActor.run { (NSApp.delegate as? AppDelegate)?.startPolling() }
        }
    }

    public func applicationWillTerminate(_ notification: Notification) {
        pollTask?.cancel()
        removeEscapeMonitor()
    }

    // MARK: - Polling

    @MainActor
    fileprivate func startPolling() {
        guard let coordinator else { return }
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await coordinator.refresh()
                let interval = await coordinator.currentInterval
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    private func refreshNow() {
        Task { [coordinator] in await coordinator?.refresh(includeHeavy: true) }
    }

    @MainActor
    fileprivate func render(_ snapshot: ProxySnapshot) {
        statusItem?.button?.image = StatusIcon.image(for: snapshot.state)
        statusItem?.button?.toolTip = "OpenCodex — \(snapshot.state.title) (\(snapshot.endpoint.display))"
        controller.apply(snapshot)
    }

    // MARK: - Actions

    /// Testing hook: drives the exact presentation path a status-item click uses, so a
    /// harness can verify key focus and Escape without Accessibility permission.
    public func debugTogglePanel() { togglePopover() }

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { return }
        if panel.isShown {
            panel.dismiss()
        } else {
            panel.present(from: button)
            installEscapeMonitor()
            Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
        }
    }

    /// Called by the panel whenever it closes, however it was dismissed.
    private func handlePanelClosed() {
        removeEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(false) }
    }

    /// The panel is key-capable, so `cancelOperation(_:)` handles Escape in the normal
    /// case. This local monitor is belt-and-braces for the window where the panel is up
    /// but focus sits elsewhere in this process, such as the confirmation sheet.
    private func installEscapeMonitor() {
        removeEscapeMonitor()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, self?.panel.isShown == true else { return event }
            self?.panel.dismiss()
            return nil
        }
    }


    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor { NSEvent.removeMonitor(monitor) }
        escapeMonitor = nil
    }

    private func openDashboard() {
        NSWorkspace.shared.open(endpoint.baseURL)
    }

    /// Stopping is destructive: it interrupts in-flight requests and stops the launchd
    /// service, so nothing restarts the proxy. It always confirms first. Drain polling
    /// and failure reporting land in Phase 3.
    private func stopProxy() {
        let alert = NSAlert()
        alert.messageText = "Stop the OpenCodex proxy?"
        alert.informativeText =
            "In-flight requests will be interrupted, and OpenCodex will not restart on its own."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stop proxy")
        alert.addButton(withTitle: "Cancel")

        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        Task { [client, coordinator] in
            try? await client?.stop()
            await coordinator?.refresh()
        }
    }
}
