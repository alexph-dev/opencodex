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
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    public func popoverDidShow(_ notification: Notification) {
        Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
    }

    public func popoverDidClose(_ notification: Notification) {
        Task { [coordinator] in await coordinator?.setPopoverOpen(false) }
    }

    private func openDashboard() {
        NSWorkspace.shared.open(endpoint.baseURL)
    }

    /// Wired fully in Phase 3; the confirmation sheet and result handling land there.
    private func stopProxy() {
        Task { [client, coordinator] in
            try? await client?.stop()
            await coordinator?.refresh()
        }
    }
}
