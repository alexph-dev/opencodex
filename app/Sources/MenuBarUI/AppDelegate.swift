import AppKit
import MenuBarCore

public final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private let controller = PopoverViewController()
    private var coordinator: PollingCoordinator?
    private var client: ProxyClient?
    private var endpoint = ProxyEndpoint.default
    private var pollTask: Task<Void, Never>?
    /// Scoped Escape handling: an accessory app's popover does not reliably receive key
    /// events through the responder chain, so the monitor is installed on open and
    /// removed on close rather than left running for the process lifetime.
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
        controller.onPrimaryAction = { [weak self] in self?.primaryAction() }
        controller.onQuit = { NSApp.terminate(nil) }

        popover.contentViewController = controller
        popover.behavior = .transient
        popover.delegate = self
        // MOTION_INTENSITY 1: no decorative animation, and none at all under reduce-motion.
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

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

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            // An accessory app is not active by default, so its popover would never
            // take key focus and the keyboard path would silently not work.
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            if let window = popover.contentViewController?.view.window {
                window.makeKeyAndOrderFront(nil)
                window.makeFirstResponder(popover.contentViewController?.view)
            }
        }
    }

    public func popoverDidShow(_ notification: Notification) {
        installEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
    }

    public func popoverDidClose(_ notification: Notification) {
        removeEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(false) }
    }

    private func installEscapeMonitor() {
        removeEscapeMonitor()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }   // Escape
            self?.popover.performClose(nil)
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

    /// The state-specific call to action. Both current cases route the user to the
    /// place they can actually resolve the problem.
    private func primaryAction() {
        openDashboard()
        refreshNow()
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
