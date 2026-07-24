import AppKit
import MenuBarCore

/// The popover body: one scroll-free column ordered by urgency.
///
/// Deliberately not a tab bar. A menu bar popover is a glance surface, and tabs would put
/// the answer to "is it fine?" one click away three times out of four.
public final class PopoverViewController: NSViewController {
    public override init(nibName: NSNib.Name?, bundle: Bundle?) { super.init(nibName: nibName, bundle: bundle) }
    public required init?(coder: NSCoder) { nil }

    private let header = StatusHeaderView()
    private let metrics = MetricsView()
    private let sparkline = SparklineView()
    private let quotaStack = NSStackView()
    private let quotaEmpty = makeLabel("No provider quota sources connected.", font: Theme.caption, color: Theme.muted)
    private let actionLabel = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let commandField = NSTextField(labelWithString: "")
    private let dashboardButton = NSButton()
    private let stopButton = NSButton()
    private let overflowButton = NSButton()
    private let metricsSeparator = makeSeparator()
    private let quotaSeparator = makeSeparator()

    public var onDashboard: (() -> Void)?
    public var onStop: (() -> Void)?
    public var onQuit: (() -> Void)?

    private var snapshot: ProxySnapshot?

    public override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: Theme.width, height: 260))

        quotaStack.orientation = .vertical
        quotaStack.alignment = .leading
        quotaStack.spacing = Theme.tightGap

        configureButtons()
        commandField.font = Theme.numericSmall
        commandField.textColor = Theme.text
        commandField.isSelectable = true
        commandField.isBordered = false
        commandField.backgroundColor = .clear

        let actions = makeRow([dashboardButton, stopButton, NSView(), overflowButton])
        actions.alignment = .centerY

        let column = NSStackView(views: [
            header,
            makeSeparator(),
            metrics,
            sparkline,
            metricsSeparator,
            quotaStack,
            quotaEmpty,
            quotaSeparator,
            actionLabel,
            commandField,
            actions,
        ])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Theme.rowGap
        column.edgeInsets = NSEdgeInsets(
            top: Theme.gutter, left: Theme.gutter,
            bottom: Theme.gutter, right: Theme.gutter
        )
        column.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(column)

        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            root.widthAnchor.constraint(equalToConstant: Theme.width),
        ])

        // Let the column drive the height so hidden sections actually shrink the
        // popover. Without this the view keeps its initial 260pt and a stopped proxy
        // renders a large empty void under the status line.
        column.setHuggingPriority(.required, for: .vertical)
        column.setContentCompressionResistancePriority(.required, for: .vertical)

        for view in [header, metrics, sparkline, quotaStack, actions] {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -Theme.gutter * 2).isActive = true
        }

        view = root
    }

    private func configureButtons() {
        for (button, title) in [(dashboardButton, "Dashboard"), (stopButton, "Stop proxy")] {
            button.title = title
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = Theme.caption
            button.target = self
        }
        dashboardButton.action = #selector(dashboardTapped)
        stopButton.action = #selector(stopTapped)

        overflowButton.title = "···"
        overflowButton.bezelStyle = .rounded
        overflowButton.controlSize = .small
        overflowButton.font = Theme.caption
        overflowButton.target = self
        overflowButton.action = #selector(overflowTapped)
        overflowButton.setAccessibilityLabel("More actions")
    }

    public func apply(_ snapshot: ProxySnapshot) {
        self.snapshot = snapshot
        header.apply(snapshot)
        metrics.apply(snapshot)
        sparkline.apply(snapshot)
        applyQuotas(snapshot)
        applyAction(snapshot)

        // Metrics and quotas are meaningless when the proxy is not answering.
        let live = snapshot.state.isRunning
        metrics.isHidden = !live
        metricsSeparator.isHidden = !live
        quotaSeparator.isHidden = !live
        if !live {
            sparkline.isHidden = true
            quotaStack.isHidden = true
            quotaEmpty.isHidden = true
        }
        stopButton.isEnabled = live

        view.layoutSubtreeIfNeeded()
        preferredContentSize = NSSize(width: Theme.width, height: view.fittingSize.height)
    }

    private func applyQuotas(_ snapshot: ProxySnapshot) {
        for view in quotaStack.arrangedSubviews { quotaStack.removeArrangedSubview(view); view.removeFromSuperview() }
        let rows = snapshot.quotaRows
        quotaStack.isHidden = rows.isEmpty
        quotaEmpty.isHidden = !(rows.isEmpty && snapshot.state.isRunning)
        for quota in rows {
            let row = QuotaRowView(quota: quota)
            row.translatesAutoresizingMaskIntoConstraints = false
            quotaStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: quotaStack.widthAnchor).isActive = true
        }
    }

    private func applyAction(_ snapshot: ProxySnapshot) {
        switch snapshot.nextAction {
        case .none:
            actionLabel.isHidden = true
            commandField.isHidden = true
        case .runCommand(let command):
            actionLabel.isHidden = false
            actionLabel.stringValue = "Start it again with:"
            commandField.isHidden = false
            commandField.stringValue = command
            commandField.setAccessibilityLabel("Start command: \(command)")
        case .addAPIKey:
            actionLabel.isHidden = false
            actionLabel.stringValue = "Add an API key in the dashboard to continue."
            commandField.isHidden = true
        case .retry:
            actionLabel.isHidden = false
            let age = Format.age(snapshot.lastUpdated)
            actionLabel.stringValue = "Showing data from \(age). Retrying automatically."
            commandField.isHidden = true
        }
    }

    @objc private func dashboardTapped() { onDashboard?() }
    @objc private func stopTapped() { onStop?() }

    @objc private func overflowTapped() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refreshTapped), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit OpenCodex", action: #selector(quitTapped), keyEquivalent: "q").target = self
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: overflowButton.bounds.height + 4), in: overflowButton)
    }

    @objc private func refreshTapped() { onRefresh?() }
    @objc private func quitTapped() { onQuit?() }

    public var onRefresh: (() -> Void)?

    public override func keyDown(with event: NSEvent) {
        // Escape closes, per the keyboard contract.
        if event.keyCode == 53 {
            view.window?.close()
            return
        }
        super.keyDown(with: event)
    }
}
