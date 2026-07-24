import AppKit

/// The popover surface.
///
/// Deliberately a panel rather than `NSPopover`. Measured on macOS 27 from an accessory
/// (`LSUIElement`) process: the window `NSPopover` creates never appears in
/// `NSApp.windows` and reports `canBecomeKey == false`, so the OS refuses to route key
/// events to it — Escape and Tab never arrive regardless of how the process is
/// activated. The same probe against this panel reports `canBecomeKey=1 isKey=1`.
///
/// `nonactivatingPanel` keeps the click-through feel of a menu bar popover: opening it
/// does not steal focus from the user's editor.
public final class PopoverPanel: NSPanel {
    /// Invoked whenever the panel closes, however it was dismissed.
    public var onDismiss: (() -> Void)?

    private var clickOutsideMonitor: Any?

    public init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 300),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        animationBehavior = .utilityWindow

        contentView?.wantsLayer = true
    }

    public override var canBecomeKey: Bool { true }
    /// Never main: this is chrome, not a document window.
    public override var canBecomeMain: Bool { false }

    public var isShown: Bool { isVisible }

    /// Presents under a status item button, clamped to the visible screen.
    public func present(from button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        layoutContent()

        let size = contentViewController?.preferredContentSize ?? frame.size
        setContentSize(size)

        let buttonRect = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        var origin = NSPoint(
            x: buttonRect.midX - size.width / 2,
            y: buttonRect.minY - size.height - 6
        )

        if let screen = buttonWindow.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
            origin.y = max(origin.y, visible.minY + 8)
        }

        setFrameOrigin(origin)
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        installClickOutsideMonitor()
    }

    public func dismiss() {
        removeClickOutsideMonitor()
        orderOut(nil)
        onDismiss?()
    }

    /// Transient behaviour: clicking anywhere else dismisses, matching what a menu bar
    /// popover trained the user to expect.
    private func installClickOutsideMonitor() {
        removeClickOutsideMonitor()
        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            self?.dismiss()
        }
    }

    private func removeClickOutsideMonitor() {
        if let monitor = clickOutsideMonitor { NSEvent.removeMonitor(monitor) }
        clickOutsideMonitor = nil
    }

    public override func cancelOperation(_ sender: Any?) { dismiss() }

    public override func resignKey() {
        super.resignKey()
        // Losing key focus means the user moved on. Do not linger like a stuck overlay.
        if isVisible { dismiss() }
    }

    private func layoutContent() {
        contentViewController?.view.layoutSubtreeIfNeeded()
    }
}
