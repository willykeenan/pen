import AppKit
import CoreGraphics
import Foundation

enum PenActivity: Equatable {
    case idle
    case drawing
    case waiting(String)

    var isActive: Bool {
        self != .idle
    }
}

@MainActor
final class OverlayCoordinator: NSObject, PenCanvasDelegate {
    var onActivityChange: ((PenActivity) -> Void)?

    private(set) var activity: PenActivity = .idle {
        didSet { onActivityChange?(activity) }
    }

    private let store: AnnotationStore
    private var panels: [OverlayPanel] = []
    private var canvases: [PenCanvasView] = []
    private weak var activeCanvas: PenCanvasView?
    private var finalizeWorkItem: DispatchWorkItem?
    private var statusTimer: Timer?
    private var permissionWatchTimer: Timer?
    private var permissionWatchTicks = 0
    private var sourceAppName: String?
    private var sourceBundleIdentifier: String?
    private var sourceApplication: NSRunningApplication?

    init(store: AnnotationStore = AnnotationStore()) {
        self.store = store
        super.init()
        try? store.prepare()
        store.cancelOrphanedCurrent()
    }

    func toggle() {
        if activity.isActive {
            cancel(reason: "Cancelled by the user from the menu bar.")
        } else {
            activate()
        }
    }

    func activate() {
        guard activity == .idle else { return }

        let frontmost = NSWorkspace.shared.frontmostApplication
        sourceApplication = frontmost
        sourceAppName = frontmost?.localizedName
        sourceBundleIdentifier = frontmost?.bundleIdentifier

        guard requestScreenCaptureIfNeeded() else { return }

        var nextPanels: [OverlayPanel] = []
        var nextCanvases: [PenCanvasView] = []

        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                continue
            }
            let displayID = CGDirectDisplayID(number.uint32Value)
            guard let capture = CGDisplayCreateImage(displayID) else { continue }

            let canvas = PenCanvasView(screen: screen, displayID: displayID, baselineCapture: capture)
            canvas.delegate = self
            let panel = OverlayPanel(screen: screen, contentView: canvas)
            nextCanvases.append(canvas)
            nextPanels.append(panel)
        }

        guard !nextPanels.isEmpty else {
            showError(
                title: "Pen could not see the screen",
                message: "Grant Screen Recording access in System Settings, then reopen Pen."
            )
            return
        }

        panels = nextPanels
        canvases = nextCanvases
        activity = .drawing
        NSCursor.crosshair.set()

        for panel in panels {
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        }
        panels.first?.makeKey()
    }

    func clearHistory() {
        if activity.isActive {
            cancel(reason: "Cleared with Pen history.")
        }
        do {
            try store.clearHistory()
        } catch {
            showError(title: "Could not clear Pen history", message: error.localizedDescription)
        }
    }

    func shutdown() {
        if activity.isActive {
            cancel(reason: "Pen quit before the AI completed the annotation.")
        }
    }

    func canvasMayBeginStroke(_ canvas: PenCanvasView) -> Bool {
        guard activity == .drawing else { return false }
        if let activeCanvas {
            return activeCanvas === canvas
        }
        activeCanvas = canvas
        return true
    }

    func canvasDidFinishStroke(_ canvas: PenCanvasView) {
        guard activity == .drawing, activeCanvas === canvas else { return }
        scheduleFinalize()
    }

    func canvasRequestedCancel(_ canvas: PenCanvasView) {
        cancel(reason: "Cancelled by the user with Escape.")
    }

    func canvasRequestedUndo(_ canvas: PenCanvasView) {
        guard activity == .drawing, activeCanvas === canvas else { return }
        finalizeWorkItem?.cancel()
        canvas.undoLastStroke()
        if canvas.strokes.isEmpty {
            activeCanvas = nil
        } else {
            scheduleFinalize()
        }
    }

    private func scheduleFinalize() {
        finalizeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.finalizeAnnotation()
        }
        finalizeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
    }

    private func finalizeAnnotation() {
        guard activity == .drawing,
              let canvas = activeCanvas,
              !canvas.strokes.isEmpty
        else { return }

        do {
            let artifact = try CaptureCropper.makeArtifact(
                capture: canvas.baselineCapture,
                screenSizePoints: canvas.bounds.size,
                strokes: canvas.strokes
            )
            let source = AnnotationSource(
                appName: sourceAppName,
                bundleIdentifier: sourceBundleIdentifier,
                displayID: canvas.displayID,
                screenFramePoints: PenRect(canvas.screen.frame)
            )
            let record = try store.save(artifact: artifact, source: source)
            activity = .waiting(record.id)
            canvases.forEach { $0.phase = .queued }
            panels.forEach { $0.allowUnderlyingInteraction() }
            sourceApplication?.activate(options: [.activateIgnoringOtherApps])
            startStatusTimer(id: record.id)
        } catch {
            showError(title: "Pen could not send this mark", message: error.localizedDescription)
            cancel(reason: "The annotation crop could not be created.")
        }
    }

    private func startStatusTimer(id: String) {
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.pollStatus(id: id)
            }
        }
        if let statusTimer {
            RunLoop.main.add(statusTimer, forMode: .common)
        }
    }

    private func pollStatus(id: String) {
        guard case .waiting(let expectedID) = activity, expectedID == id,
              let record = try? store.read(id: id)
        else { return }

        switch record.status {
        case .pending:
            canvases.forEach { $0.phase = .queued }
        case .reading:
            canvases.forEach { $0.phase = .reading }
        case .completing:
            canvases.forEach { $0.phase = .completing }
            if let clearDate = PenClock.date(record.clearAfter), clearDate <= Date() {
                finish(id: id)
            }
        case .complete, .cancelled:
            fadeAndClose()
        }
    }

    private func finish(id: String) {
        try? store.setStatus(id: id, status: .complete)
        fadeAndClose()
    }

    private func cancel(reason: String) {
        finalizeWorkItem?.cancel()
        if case .waiting(let id) = activity {
            try? store.setStatus(id: id, status: .cancelled, cancelReason: reason)
        }
        closeImmediately()
    }

    private func fadeAndClose() {
        statusTimer?.invalidate()
        statusTimer = nil
        let activePanels = panels
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.24
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            activePanels.forEach { $0.animator().alphaValue = 0 }
        } completionHandler: { [weak self] in
            Task { @MainActor in
                self?.closeImmediately()
            }
        }
    }

    private func closeImmediately() {
        statusTimer?.invalidate()
        statusTimer = nil
        finalizeWorkItem?.cancel()
        finalizeWorkItem = nil
        panels.forEach { $0.close() }
        panels.removeAll()
        canvases.removeAll()
        activeCanvas = nil
        sourceAppName = nil
        sourceBundleIdentifier = nil
        sourceApplication = nil
        NSCursor.arrow.set()
        activity = .idle
    }

    private func requestScreenCaptureIfNeeded() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        // First-ever ask for this build shows the system prompt; later calls
        // return false silently, so fall through to recovery guidance.
        if CGRequestScreenCaptureAccess() { return true }
        presentScreenCaptureRecovery()
        return false
    }

    private func presentScreenCaptureRecovery() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Give Pen Screen Recording access"
        alert.informativeText = """
        Pen only captures the region you draw around, and macOS requires Screen Recording \
        permission for that local crop.

        macOS ties the approval to each exact build of Pen. If Pen already shows as enabled in \
        System Settings › Privacy & Security › Screen Recording, that switch belongs to an older \
        build — toggle it off and back on (or remove Pen with the − button, then add it again). \
        “Reset Pen’s Approval” clears the stale entry so macOS asks fresh.

        Pen relaunches itself automatically as soon as access goes live.
        """
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Reset Pen’s Approval")
        alert.addButton(withTitle: "Not now")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
            watchForScreenCaptureGrant()
        case .alertSecondButtonReturn:
            resetScreenCaptureApproval()
            _ = CGRequestScreenCaptureAccess()
            watchForScreenCaptureGrant()
        default:
            break
        }
    }

    /// Drops this app's own (possibly stale) Screen Recording row from TCC so the
    /// next request re-prompts cleanly. Removal only — granting stays a manual,
    /// user-performed step in System Settings.
    private func resetScreenCaptureApproval() {
        let bundleID = Bundle.main.bundleIdentifier ?? "dev.kestudios.pen"
        let reset = Process()
        reset.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        reset.arguments = ["reset", "ScreenCapture", bundleID]
        try? reset.run()
        reset.waitUntilExit()
    }

    /// A grant made while the app is running never applies to the running process,
    /// so poll for it and relaunch once it lands. Gives up quietly after 5 minutes.
    private func watchForScreenCaptureGrant() {
        permissionWatchTimer?.invalidate()
        permissionWatchTicks = 0
        permissionWatchTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.pollScreenCaptureGrant()
            }
        }
        if let permissionWatchTimer {
            RunLoop.main.add(permissionWatchTimer, forMode: .common)
        }
    }

    private func pollScreenCaptureGrant() {
        permissionWatchTicks += 1
        if CGPreflightScreenCaptureAccess() {
            permissionWatchTimer?.invalidate()
            permissionWatchTimer = nil
            relaunchForFreshPermission()
        } else if permissionWatchTicks > 150 {
            permissionWatchTimer?.invalidate()
            permissionWatchTimer = nil
        }
    }

    private func relaunchForFreshPermission() {
        let bundlePath = Bundle.main.bundlePath
        let relauncher = Process()
        relauncher.executableURL = URL(fileURLWithPath: "/bin/sh")
        relauncher.arguments = ["-c", "sleep 0.7; /usr/bin/open -n \"\(bundlePath)\""]
        try? relauncher.run()
        NSApp.terminate(nil)
    }

    private func showError(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
