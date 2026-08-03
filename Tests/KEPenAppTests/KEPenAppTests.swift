import AppKit
import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import KEPenCore

final class KEPenAppTests: XCTestCase {
    func testGlobalShortcutIsDeliberateAndDiscoverable() {
        let shortcut = PenHotKeyDescriptor.toggle
        XCTAssertEqual(shortcut.keyCode, UInt32(kVK_ANSI_P))
        XCTAssertEqual(shortcut.modifiers, UInt32(controlKey | optionKey | cmdKey))
        XCTAssertEqual(shortcut.displayName, "⌃⌥⌘P")
    }

    func testCropArtifactIncludesInkAndUsesCircledBounds() throws {
        let capture = try makeSolidImage(width: 100, height: 100)
        let strokes = [[
            PenPoint(CGPoint(x: 10, y: 10), t: 0),
            PenPoint(CGPoint(x: 30, y: 10), t: 0.1),
            PenPoint(CGPoint(x: 30, y: 30), t: 0.2),
            PenPoint(CGPoint(x: 10, y: 30), t: 0.3),
            PenPoint(CGPoint(x: 10, y: 10), t: 0.4),
        ]]

        let artifact = try CaptureCropper.makeArtifact(
            capture: capture,
            screenSizePoints: CGSize(width: 100, height: 100),
            strokes: strokes,
            paddingPoints: 0
        )

        XCTAssertEqual(artifact.width, 20)
        XCTAssertEqual(artifact.height, 20)
        XCTAssertEqual(artifact.cropRectPixels, CGRect(x: 10, y: 10, width: 20, height: 20))
        let normalizedFirst = try XCTUnwrap(artifact.normalizedStrokes.first?.first)
        XCTAssertEqual(normalizedFirst.x, 0, accuracy: 0.001)
        XCTAssertEqual(normalizedFirst.y, 0, accuracy: 0.001)

        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: artifact.png))
        var foundRedInk = false
        for x in 0..<bitmap.pixelsWide {
            for y in 0..<bitmap.pixelsHigh {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                if color.redComponent > 0.8, color.greenComponent < 0.5, color.blueComponent < 0.5 {
                    foundRedInk = true
                    break
                }
            }
            if foundRedInk { break }
        }
        XCTAssertTrue(foundRedInk, "The MCP crop should visibly retain the user's red ink.")
    }

    func testStorePersistsAttributionAndLifecycleContract() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ke-pen-swift-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = AnnotationStore(root: root)
        let artifact = CropArtifact(
            png: Data([0x89, 0x50, 0x4E, 0x47]),
            width: 20,
            height: 20,
            strokeBoundsPoints: CGRect(x: 1, y: 2, width: 3, height: 4),
            cropRectPixels: CGRect(x: 0, y: 0, width: 20, height: 20),
            normalizedStrokes: [[PenPoint(CGPoint(x: 0.5, y: 0.5), t: 0)]]
        )
        let source = AnnotationSource(
            appName: "Xcode",
            bundleIdentifier: "com.apple.dt.Xcode",
            displayID: 1,
            screenFramePoints: PenRect(CGRect(x: 0, y: 0, width: 100, height: 100))
        )

        let saved = try store.save(artifact: artifact, source: source)
        let current = try XCTUnwrap(store.current())
        XCTAssertEqual(current.id, saved.id)
        XCTAssertEqual(current.status, .pending)
        XCTAssertEqual(current.credit.creator, "William Keenan")
        XCTAssertEqual(current.credit.studio, "K&E Studios")

        try store.setStatus(id: saved.id, status: .cancelled, cancelReason: "test")
        XCTAssertEqual(try store.current()?.status, .cancelled)
        XCTAssertThrowsError(try store.read(id: "../../etc/passwd"))
    }

    func testClockRoundTripsFractionalISO8601() {
        let now = Date()
        let encoded = PenClock.string(now)
        let decoded = PenClock.date(encoded)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.timeIntervalSince1970 ?? 0, now.timeIntervalSince1970, accuracy: 0.001)
    }

    private func makeSolidImage(width: Int, height: Int) throws -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        context.setFillColor(NSColor(calibratedWhite: 0.2, alpha: 1).cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }
}
