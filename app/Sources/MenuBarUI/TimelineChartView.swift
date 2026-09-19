import AppKit
import MenuBarCore

public final class TimelineChartView: NSView {
    private var timeline: UsageTimeline?
    private var settings = CompanionSettings.defaults
    private let colors = [0x0A84FF, 0xFF9F0A, 0x30D158, 0xBF5AF2, 0xFF453A, 0x64D2FF]

    public override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 104)
    }

    public func apply(_ snapshot: ProxySnapshot) {
        settings = snapshot.settings
        timeline = snapshot.timeline
        isHidden = !settings.showChart || timeline == nil
        setAccessibilityLabel("Usage timeline")
        needsDisplay = true
    }

    public override func draw(_ dirtyRect: NSRect) {
        guard let timeline, !timeline.isEmpty else {
            if settings.showChart {
                drawText("No token usage in this window.", in: NSRect(x: 0, y: 36, width: bounds.width, height: 16), font: Theme.caption, color: Theme.muted)
            }
            return
        }
        let chartHeight: CGFloat = 72
        let maxValue = settings.chartStyle == .stackedBar ? timeline.stackedMax : timeline.maxPoint
        drawText(Format.tokens(Int(maxValue.rounded())), in: NSRect(x: 0, y: chartHeight + 8, width: bounds.width, height: 14), font: Theme.micro, color: Theme.muted, alignment: .right)
        let window = timeline.buckets * timeline.bucketSeconds / 3600
        let windowLabel = window >= 24 ? "\(window / 24)d" : "\(window)h"
        drawText(windowLabel, in: NSRect(x: 0, y: chartHeight + 8, width: 40, height: 14), font: Theme.micro, color: Theme.muted)

        let plot = NSRect(x: 0, y: 20, width: bounds.width, height: chartHeight)
        Theme.muted.setStroke()
        let baseline = NSBezierPath()
        baseline.move(to: NSPoint(x: plot.minX, y: plot.minY))
        baseline.line(to: NSPoint(x: plot.maxX, y: plot.minY))
        baseline.lineWidth = 0.5
        baseline.stroke()

        if settings.chartStyle == .stackedBar {
            drawBars(timeline, in: plot, maxValue: maxValue)
        } else {
            drawLines(timeline, in: plot, maxValue: maxValue)
        }

        let legend = timeline.series.prefix(4).enumerated().map { "\($0.offset + 1). \($0.element.id)" }.joined(separator: "  ")
        let extra = max(0, timeline.series.count - 4)
        let legendText = extra > 0 ? "\(legend)  +\(extra) more" : legend
        drawText(legendText, in: NSRect(x: 0, y: 0, width: bounds.width, height: 14), font: Theme.micro, color: Theme.muted)
    }

    private func drawText(
        _ text: String, in rect: NSRect, font: NSFont, color: NSColor, alignment: NSTextAlignment = .left
    ) {
        let style = NSMutableParagraphStyle()
        style.alignment = alignment
        NSAttributedString(
            string: text,
            attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style]
        ).draw(in: rect)
    }

    private func drawLines(_ timeline: UsageTimeline, in plot: NSRect, maxValue: Double) {
        guard timeline.buckets > 1, maxValue > 0 else { return }
        for (seriesIndex, series) in timeline.series.enumerated() {
            let path = NSBezierPath()
            for (index, value) in series.points.enumerated() {
                let x = plot.minX + plot.width * CGFloat(index) / CGFloat(max(timeline.buckets - 1, 1))
                let y = plot.minY + plot.height * CGFloat(value / maxValue)
                if index == 0 { path.move(to: NSPoint(x: x, y: y)) } else { path.line(to: NSPoint(x: x, y: y)) }
            }
            NSColor(hex: colors[seriesIndex % colors.count]).setStroke()
            path.lineWidth = 1.5
            path.stroke()
        }
    }

    private func drawBars(_ timeline: UsageTimeline, in plot: NSRect, maxValue: Double) {
        guard timeline.buckets > 0, maxValue > 0 else { return }
        let width = max(1, plot.width / CGFloat(timeline.buckets) - 1)
        for bucket in 0..<timeline.buckets {
            var y = plot.minY
            for (seriesIndex, series) in timeline.series.enumerated() {
                let value = series.points.indices.contains(bucket) ? series.points[bucket] : 0
                let height = plot.height * CGFloat(value / maxValue)
                NSColor(hex: colors[seriesIndex % colors.count]).setFill()
                NSRect(x: plot.minX + CGFloat(bucket) * (width + 1), y: y, width: width, height: height).fill()
                y += height
            }
        }
    }
}
