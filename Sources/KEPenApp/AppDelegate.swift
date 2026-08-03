import AppKit

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private let coordinator = OverlayCoordinator()
    private var statusItem: NSStatusItem!

    public override init() {
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        guard let button = statusItem.button else { return }
        button.image = NSImage(systemSymbolName: "pencil.tip.crop.circle", accessibilityDescription: "Pen")
        button.image?.isTemplate = true
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.toolTip = "Pen by KE Studios — click to draw; right-click for menu"

        coordinator.onActivityChange = { [weak self] activity in
            self?.render(activity)
        }
        render(.idle)
    }

    public func applicationWillTerminate(_ notification: Notification) {
        coordinator.shutdown()
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        guard let event = NSApp.currentEvent else {
            coordinator.toggle()
            return
        }

        if event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            statusItem.menu = buildMenu()
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else {
            coordinator.toggle()
        }
    }

    @objc private func toggleFromMenu(_ sender: Any?) {
        coordinator.toggle()
    }

    @objc private func clearHistory(_ sender: Any?) {
        coordinator.clearHistory()
    }

    @objc private func visitStudio(_ sender: Any?) {
        guard let url = URL(string: "https://kestudios.dev/?ref=pen") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func showAbout(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Pen"
        alert.informativeText = "Point at the bug. Your AI gets the point.\n\nCreated by William Keenan at K&E Studios. Free forever.\n\nkestudios.dev"
        alert.addButton(withTitle: "Visit kestudios.dev")
        alert.addButton(withTitle: "Close")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            visitStudio(nil)
        }
    }

    @objc private func quit(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let toggleTitle = coordinator.activity.isActive ? "Cancel Pen" : "Draw with Pen"
        menu.addItem(withTitle: toggleTitle, action: #selector(toggleFromMenu(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Clear Pen History", action: #selector(clearHistory(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Visit kestudios.dev", action: #selector(visitStudio(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "About Pen", action: #selector(showAbout(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Pen", action: #selector(quit(_:)), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        return menu
    }

    private func render(_ activity: PenActivity) {
        guard let button = statusItem.button else { return }
        let symbol: String
        switch activity {
        case .idle: symbol = "pencil.tip.crop.circle"
        case .drawing: symbol = "pencil.tip.crop.circle.fill"
        case .waiting: symbol = "eye.circle.fill"
        }
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Pen")
        button.image?.isTemplate = activity == .idle
        button.contentTintColor = activity == .idle ? nil : .systemRed
    }
}
