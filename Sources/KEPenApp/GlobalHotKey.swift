import Carbon.HIToolbox
import Foundation

struct PenHotKeyDescriptor: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
    let displayName: String

    static let toggle = PenHotKeyDescriptor(
        keyCode: UInt32(kVK_ANSI_P),
        modifiers: UInt32(controlKey | optionKey | cmdKey),
        displayName: "⌃⌥⌘P"
    )
}

@MainActor
final class PenGlobalHotKey {
    private static let signature = OSType(0x4B45504E) // KEPN
    private static let identifier: UInt32 = 1

    private var eventHandler: EventHandlerRef?
    private var hotKey: EventHotKeyRef?
    private var action: (() -> Void)?

    @discardableResult
    func start(
        descriptor: PenHotKeyDescriptor = .toggle,
        action: @escaping () -> Void
    ) -> OSStatus {
        stop()
        self.action = action

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData in
                guard let userData else { return OSStatus(eventNotHandledErr) }
                let instance = Unmanaged<PenGlobalHotKey>
                    .fromOpaque(userData)
                    .takeUnretainedValue()
                Task { @MainActor in
                    instance.fire()
                }
                return noErr
            },
            1,
            &eventType,
            userData,
            &eventHandler
        )
        guard installStatus == noErr else {
            self.action = nil
            return installStatus
        }

        let identifier = EventHotKeyID(
            signature: Self.signature,
            id: Self.identifier
        )
        let registerStatus = RegisterEventHotKey(
            descriptor.keyCode,
            descriptor.modifiers,
            identifier,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        if registerStatus != noErr {
            stop()
        }
        return registerStatus
    }

    func stop() {
        if let hotKey {
            UnregisterEventHotKey(hotKey)
            self.hotKey = nil
        }
        if let eventHandler {
            RemoveEventHandler(eventHandler)
            self.eventHandler = nil
        }
        action = nil
    }

    private func fire() {
        action?()
    }
}
