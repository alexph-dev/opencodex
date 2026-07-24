import AppKit

/// Tokens derived from `gui/src/styles.css` so the companion and the dashboard agree on
/// what "healthy" looks like.
///
/// Where AppKit already has a semantic colour, it wins over a hardcoded hex: it tracks
/// light/dark *and* the increased-contrast and vibrancy accessibility settings, which a
/// literal cannot.
enum Theme {
    // Surfaces
    static let separator = NSColor.separatorColor
    static let raised = NSColor.controlBackgroundColor

    // Text: --text / --muted / --faint
    //
    // `tertiaryLabelColor` measured 2.01:1 in light and 2.39:1 in dark against the
    // popover material — well under the 4.5:1 required for normal text. AppKit's
    // tertiary tier is intended for disabled affordances, not for information the user
    // has to read, and every label using this tier here (range heading, metric captions,
    // quota window labels) carries real meaning. Calibrated tokens replace it.
    static let text = NSColor.labelColor
    static let muted = NSColor.secondaryLabelColor
    /// Small supporting text that must still be legible: 10-11pt captions and labels.
    static let faint = dynamic(light: 0x55534F, dark: 0xB8B6B3)
    /// Graphical marks only, held to the 3:1 non-text threshold.
    static let graphMark = dynamic(light: 0x8A8782, dark: 0x94918C)

    // State colours, taken verbatim from styles.css.
    static let green = dynamic(light: 0x0A7D5C, dark: 0x4ECB9D)
    static let amber = dynamic(light: 0x9A4A08, dark: 0xFBBF24)
    static let red = dynamic(light: 0xB91C1C, dark: 0xF87171)

    // Type ladder: --text-micro / --text-caption / --text-label / --text-control.
    static let micro = NSFont.systemFont(ofSize: 10, weight: .medium)
    static let caption = NSFont.systemFont(ofSize: 11)
    static let label = NSFont.systemFont(ofSize: 12, weight: .semibold)
    /// Monospaced digits are the AppKit equivalent of `font-variant-numeric: tabular-nums`.
    /// Without this, polling makes every digit jitter.
    static let numeric = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)
    static let numericSmall = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)

    // Geometry: --space-* and --radius-sm.
    static let gutter: CGFloat = 12
    static let rowGap: CGFloat = 8
    static let tightGap: CGFloat = 4
    static let radius: CGFloat = 8
    static let width: CGFloat = 340

    static func color(for tone: ProxyToneBridge) -> NSColor {
        switch tone {
        case .neutral: return muted
        case .good: return green
        case .warning: return amber
        case .bad: return red
        }
    }

    /// Quota fill: green under 80, amber to 95, red above. The percentage is always
    /// printed beside the bar, so colour is reinforcement rather than the only signal.
    static func quotaColor(percent: Double?) -> NSColor {
        guard let percent else { return faint }
        if percent > 95 { return red }
        if percent >= 80 { return amber }
        return green
    }

    /// `light-dark()` equivalent: resolves per appearance instead of at creation time.
    private static func dynamic(light: Int, dark: Int) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }
}

/// Mirrors `ProxyState.Tone` without importing AppKit into the core module.
enum ProxyToneBridge {
    case neutral, good, warning, bad
}

extension NSColor {
    convenience init(hex: Int) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
