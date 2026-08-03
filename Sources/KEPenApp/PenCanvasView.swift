import AppKit

enum PenCanvasPhase: Equatable {
    case drawing
    case queued
    case reading
    case completing

    var message: String {
        switch self {
        case .drawing: return "DRAW · release to send"
        case .queued: return "AI IS LOOKING · ink stays until reply"
        case .reading: return "UNDERSTOOD · waiting for reply"
        case .completing: return "REPLY READY · clearing"
        }
    }
}

@MainActor
protocol PenCanvasDelegate: AnyObject {
    func canvasMayBeginStroke(_ canvas: PenCanvasView) -> Bool
    func canvasDidFinishStroke(_ canvas: PenCanvasView)
    func canvasRequestedCancel(_ canvas: PenCanvasView)
    func canvasRequestedUndo(_ canvas: PenCanvasView)
}

final class PenCanvasView: NSView {
    weak var delegate: PenCanvasDelegate?
    let screen: NSScreen
    let displayID: CGDirectDisplayID
    let baselineCapture: CGImage
    var strokes: [[PenPoint]] = []
    var phase: PenCanvasPhase = .drawing {
        didSet { needsDisplay = true }
    }

    private var currentStroke: [PenPoint]?
    private let startedAt = ProcessInfo.processInfo.systemUptime

    init(screen: NSScreen, displayID: CGDirectDisplayID, baselineCapture: CGImage) {
        self.screen = screen
        self.displayID = displayID
        self.baselineCapture = baselineCapture
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: phase == .drawing ? .crosshair : .arrow)
    }

    override func mouseDown(with event: NSEvent) {
        guard phase == .drawing, delegate?.canvasMayBeginStroke(self) == true else {
            NSSound.beep()
            return
        }
        let point = convert(event.locationInWindow, from: nil)
        currentStroke = [sample(point)]
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard phase == .drawing, var currentStroke else { return }
        let point = convert(event.locationInWindow, from: nil)
        if let last = currentStroke.last?.cgPoint,
           hypot(point.x - last.x, point.y - last.y) < 0.8 {
            return
        }
        currentStroke.append(sample(point))
        self.currentStroke = currentStroke
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard phase == .drawing, var currentStroke else { return }
        let point = convert(event.locationInWindow, from: nil)
        currentStroke.append(sample(point))

        if currentStroke.count == 2,
           let first = currentStroke.first?.cgPoint,
           hypot(point.x - first.x, point.y - first.y) < 1 {
            currentStroke.append(PenPoint(CGPoint(x: point.x + 2, y: point.y + 2), t: currentStroke.last?.t ?? 0))
        }

        strokes.append(currentStroke)
        self.currentStroke = nil
        needsDisplay = true
        delegate?.canvasDidFinishStroke(self)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            delegate?.canvasRequestedCancel(self)
            return
        }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "z" {
            delegate?.canvasRequestedUndo(self)
            return
        }
        super.keyDown(with: event)
    }

    func undoLastStroke() {
        guard phase == .drawing, !strokes.isEmpty else { return }
        strokes.removeLast()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawStrokes(strokes)
        if let currentStroke { drawStrokes([currentStroke]) }
        drawBadge()
    }

    private func drawStrokes(_ strokes: [[PenPoint]]) {
        NSGraphicsContext.current?.shouldAntialias = true
        NSColor(calibratedRed: 1, green: 0.16, blue: 0.12, alpha: 0.98).setStroke()

        for stroke in strokes where !stroke.isEmpty {
            let path = NSBezierPath()
            path.lineWidth = 4
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            for (index, point) in stroke.enumerated() {
                if index == 0 { path.move(to: point.cgPoint) } else { path.line(to: point.cgPoint) }
            }
            path.stroke()
        }
    }

    private func drawBadge() {
        let brand = "PEN · KE STUDIOS"
        let detail = phase.message
        let brandFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
        let detailFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        let brandAttributes: [NSAttributedString.Key: Any] = [
            .font: brandFont,
            .foregroundColor: NSColor.white
        ]
        let detailAttributes: [NSAttributedString.Key: Any] = [
            .font: detailFont,
            .foregroundColor: NSColor(calibratedWhite: 0.82, alpha: 1)
        ]
        let brandSize = brand.size(withAttributes: brandAttributes)
        let detailSize = detail.size(withAttributes: detailAttributes)
        let width = max(brandSize.width, detailSize.width) + 28
        let height: CGFloat = 52
        let rect = NSRect(x: 18, y: 18, width: width, height: height)

        NSColor(calibratedWhite: 0.035, alpha: 0.91).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 13, yRadius: 13).fill()
        NSColor(calibratedRed: 1, green: 0.16, blue: 0.12, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: rect.minX + 12, y: rect.minY + 12, width: 6, height: 6)).fill()

        brand.draw(at: NSPoint(x: rect.minX + 14, y: rect.minY + 8), withAttributes: brandAttributes)
        detail.draw(at: NSPoint(x: rect.minX + 14, y: rect.minY + 27), withAttributes: detailAttributes)
    }

    private func sample(_ point: CGPoint) -> PenPoint {
        PenPoint(point, t: ProcessInfo.processInfo.systemUptime - startedAt)
    }
}
