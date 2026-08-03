import AppKit
import CoreGraphics
import CryptoKit
import Foundation

enum CaptureCropError: Error, LocalizedError {
    case noPoints
    case invalidScreenSize
    case cropFailed
    case bitmapFailed
    case pngFailed

    var errorDescription: String? {
        switch self {
        case .noPoints: return "Draw a visible stroke before sending it to the AI."
        case .invalidScreenSize: return "Pen could not map this display's pixel scale."
        case .cropFailed: return "Pen could not crop the selected screen region."
        case .bitmapFailed: return "Pen could not create the annotated image."
        case .pngFailed: return "Pen could not encode the selected image."
        }
    }
}

enum CaptureCropper {
    static func makeArtifact(
        capture: CGImage,
        screenSizePoints: CGSize,
        strokes: [[PenPoint]],
        paddingPoints: CGFloat = 44
    ) throws -> CropArtifact {
        guard screenSizePoints.width > 0, screenSizePoints.height > 0 else {
            throw CaptureCropError.invalidScreenSize
        }

        let allPoints = strokes.flatMap { $0.map(\.cgPoint) }
        guard let first = allPoints.first else { throw CaptureCropError.noPoints }

        var minX = first.x
        var minY = first.y
        var maxX = first.x
        var maxY = first.y
        for point in allPoints.dropFirst() {
            minX = min(minX, point.x)
            minY = min(minY, point.y)
            maxX = max(maxX, point.x)
            maxY = max(maxY, point.y)
        }

        let rawBounds = CGRect(
            x: minX,
            y: minY,
            width: max(maxX - minX, 2),
            height: max(maxY - minY, 2)
        )
        let padded = rawBounds.insetBy(dx: -paddingPoints, dy: -paddingPoints)
        let pointRect = padded.intersection(CGRect(origin: .zero, size: screenSizePoints))

        let scaleX = CGFloat(capture.width) / screenSizePoints.width
        let scaleY = CGFloat(capture.height) / screenSizePoints.height
        let pixelRect = CGRect(
            x: floor(pointRect.minX * scaleX),
            y: floor(pointRect.minY * scaleY),
            width: ceil(pointRect.width * scaleX),
            height: ceil(pointRect.height * scaleY)
        ).intersection(CGRect(x: 0, y: 0, width: capture.width, height: capture.height))

        guard pixelRect.width >= 2,
              pixelRect.height >= 2,
              let cropped = capture.cropping(to: pixelRect)
        else { throw CaptureCropError.cropFailed }

        let width = cropped.width
        let height = cropped.height
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw CaptureCropError.bitmapFailed }

        bitmap.size = NSSize(width: width, height: height)
        guard let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
            throw CaptureCropError.bitmapFailed
        }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics

        let base = NSImage(cgImage: cropped, size: NSSize(width: width, height: height))
        base.draw(
            in: NSRect(x: 0, y: 0, width: width, height: height),
            from: .zero,
            operation: .copy,
            fraction: 1
        )

        let strokeColor = NSColor(calibratedRed: 1, green: 0.22, blue: 0.15, alpha: 0.98)
        strokeColor.setStroke()
        let lineWidth = max(4, ((scaleX + scaleY) / 2) * 4)
        for stroke in strokes where !stroke.isEmpty {
            let path = NSBezierPath()
            path.lineWidth = lineWidth
            path.lineCapStyle = .round
            path.lineJoinStyle = .round

            for (index, sample) in stroke.enumerated() {
                let pixelX = CGFloat(sample.x) * scaleX - pixelRect.minX
                let topDownY = CGFloat(sample.y) * scaleY - pixelRect.minY
                let pixelY = CGFloat(height) - topDownY
                let point = NSPoint(x: pixelX, y: pixelY)
                if index == 0 { path.move(to: point) } else { path.line(to: point) }
            }
            path.stroke()
        }

        graphics.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()

        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw CaptureCropError.pngFailed
        }

        let normalized = strokes.map { stroke in
            stroke.map { sample in
                let px = CGFloat(sample.x) * scaleX - pixelRect.minX
                let py = CGFloat(sample.y) * scaleY - pixelRect.minY
                return PenPoint(
                    CGPoint(
                        x: min(max(px / CGFloat(width), 0), 1),
                        y: min(max(py / CGFloat(height), 0), 1)
                    ),
                    t: sample.t
                )
            }
        }

        return CropArtifact(
            png: png,
            width: width,
            height: height,
            strokeBoundsPoints: rawBounds,
            cropRectPixels: pixelRect,
            normalizedStrokes: normalized
        )
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

