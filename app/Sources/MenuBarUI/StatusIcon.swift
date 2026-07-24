import AppKit
import MenuBarCore

/// The menu bar glyph.
///
/// Drawn as vector paths rather than shipped as PNGs, so it stays crisp at every scale
/// factor and inverts correctly as a template image.
///
/// Colour is deliberately absent here. macOS menu bar items are monochrome by
/// convention, and a coloured dot up there is the tell of an app that does not respect
/// the platform. State is carried by fill and by a notch instead. The coloured dot lives
/// inside the popover, where it sits beside a word and so never encodes meaning by
/// colour alone.
enum StatusIcon {
    static let size = NSSize(width: 17, height: 17)

    static func image(for state: ProxyState) -> NSImage {
        switch state {
        case .running(let health) where health.isProtected:
            return mark(filled: true, notched: false, alpha: 1)
        case .running:
            return mark(filled: true, notched: true, alpha: 1)
        case .loading, .degraded:
            return mark(filled: false, notched: false, alpha: 1)
        case .unreachable, .unauthorized:
            return mark(filled: false, notched: false, alpha: 0.4)
        }
    }

    /// A rounded square bracket pair — the OpenCodex mark reduced to menu bar scale.
    private static func mark(filled: Bool, notched: Bool, alpha: CGFloat) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            let inset = rect.insetBy(dx: 2.5, dy: 2.5)
            let path = NSBezierPath(roundedRect: inset, xRadius: 4, yRadius: 4)
            path.lineWidth = 1.6

            NSColor.black.withAlphaComponent(alpha).setStroke()
            NSColor.black.withAlphaComponent(alpha).setFill()

            if filled {
                path.fill()
            } else {
                path.stroke()
            }

            if notched {
                // A single carved notch marks "running but unprotected" without colour.
                let notch = NSBezierPath()
                let midY = inset.midY
                notch.move(to: NSPoint(x: inset.maxX - 3.5, y: midY))
                notch.line(to: NSPoint(x: inset.maxX + 0.5, y: midY))
                notch.lineWidth = 2.4
                NSColor.clear.setStroke()
                // Erase rather than draw: the notch must read as a gap in the mark.
                NSGraphicsContext.current?.compositingOperation = .clear
                notch.stroke()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
