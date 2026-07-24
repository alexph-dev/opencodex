import AppKit
import MenuBarCore

/// Collapsed provider list with per-provider enable/disable switches.
///
/// Collapsed by default: reading status is frequent, toggling a provider is rare, and
/// the urgency order in `003` puts actions below information.
final class ProviderListView: NSView {
    private let disclosure = NSButton()
    private let summary = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let rows = NSStackView()
    private var expanded = false
    private var snapshot: ProxySnapshot?

    /// `(provider, shouldDisable)`.
    var onToggle: ((String, Bool) -> Void)?

    init() {
        super.init(frame: .zero)

        disclosure.bezelStyle = .disclosure
        disclosure.setButtonType(.onOff)
        disclosure.title = ""
        disclosure.target = self
        disclosure.action = #selector(toggleExpanded)
        disclosure.setAccessibilityLabel("Show providers")

        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = Theme.tightGap
        rows.isHidden = true

        let header = NSStackView(views: [disclosure, summary])
        header.orientation = .horizontal
        header.spacing = Theme.tightGap
        header.alignment = .centerY

        let column = NSStackView(views: [header, rows])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Theme.tightGap
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        self.snapshot = snapshot

        guard snapshot.providersLoaded else {
            isHidden = true
            return
        }
        isHidden = false

        if snapshot.providers.isEmpty {
            summary.stringValue = "No providers configured."
            disclosure.isHidden = true
            rows.isHidden = true
            return
        }

        disclosure.isHidden = false
        let enabled = snapshot.providers.filter(\.isEnabled).count
        summary.stringValue = "\(enabled) of \(snapshot.providers.count) providers enabled"
        rebuildRows(snapshot)
        rows.isHidden = !expanded
    }

    private func rebuildRows(_ snapshot: ProxySnapshot) {
        for view in rows.arrangedSubviews {
            rows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        for provider in snapshot.providers.sorted(by: { $0.name < $1.name }) {
            let isDefault = provider.name == snapshot.defaultProvider
            let row = ProviderRowView(
                provider: provider,
                isDefault: isDefault
            ) { [weak self] shouldDisable in
                self?.onToggle?(provider.name, shouldDisable)
            }
            row.translatesAutoresizingMaskIntoConstraints = false
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
    }

    @objc private func toggleExpanded() {
        expanded = disclosure.state == .on
        rows.isHidden = !expanded
        disclosure.setAccessibilityLabel(expanded ? "Hide providers" : "Show providers")
        // The popover has to grow or shrink with the disclosure.
        (window?.contentViewController as? PopoverViewController)?.refreshSize()
    }

    /// Reverts a switch after the proxy rejected the change.
    func revert(_ name: String, to enabled: Bool) {
        for case let row as ProviderRowView in rows.arrangedSubviews where row.providerName == name {
            row.setEnabled(enabled)
        }
    }
}

final class ProviderRowView: NSView {
    let providerName: String
    private let toggle = NSSwitch()
    private let onToggle: (Bool) -> Void

    init(provider: ProviderSummary, isDefault: Bool, onToggle: @escaping (Bool) -> Void) {
        self.providerName = provider.name
        self.onToggle = onToggle
        super.init(frame: .zero)

        let name = makeLabel(provider.name, font: Theme.caption, color: Theme.text)
        let detail = makeLabel(
            isDefault ? "default" : (provider.authMode ?? ""),
            font: Theme.micro,
            color: Theme.faint
        )

        let labels = NSStackView(views: [name, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 0

        toggle.state = provider.isEnabled ? .on : .off
        toggle.controlSize = .mini
        toggle.target = self
        toggle.action = #selector(switched)

        // The proxy rejects disabling the default provider with a 400, so the control is
        // inert and explains itself rather than offering an action that cannot succeed.
        toggle.isEnabled = !isDefault
        toggle.toolTip = isDefault
            ? "This is the default provider. Choose another default in the dashboard first."
            : nil
        toggle.setAccessibilityLabel("\(provider.name) enabled")

        let row = NSStackView(views: [labels, NSView(), toggle])
        row.orientation = .horizontal
        row.spacing = Theme.rowGap
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func setEnabled(_ enabled: Bool) { toggle.state = enabled ? .on : .off }

    @objc private func switched() {
        // Optimistic: the switch has already moved. The caller reverts on failure.
        onToggle(toggle.state == .off)
    }
}
