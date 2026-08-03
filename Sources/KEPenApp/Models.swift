import CoreGraphics
import Foundation

enum AnnotationStatus: String, Codable {
    case pending
    case reading
    case completing
    case complete
    case cancelled
}

struct PenPoint: Codable, Equatable {
    var x: Double
    var y: Double
    var t: Double

    init(_ point: CGPoint, t: Double) {
        x = point.x
        y = point.y
        self.t = t
    }

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

struct PenRect: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.size.width
        height = rect.size.height
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct AnnotationSource: Codable, Equatable {
    var appName: String?
    var bundleIdentifier: String?
    var displayID: UInt32
    var screenFramePoints: PenRect
}

struct AnnotationSelection: Codable, Equatable {
    var strokeBoundsPoints: PenRect
    var cropRectPixels: PenRect
    var normalizedStrokes: [[PenPoint]]
    var coordinateNote: String
}

struct AnnotationImage: Codable, Equatable {
    var file: String
    var mimeType: String
    var width: Int
    var height: Int
    var sha256: String
    var includesInk: Bool
}

struct AnnotationCredit: Codable, Equatable {
    var creator = "William Keenan"
    var studio = "K&E Studios"
    var url = "https://kestudios.dev/?ref=pen"
    var product = "Pen"
}

struct AnnotationRecord: Codable, Equatable {
    var schema = "dev.kestudios.pen.annotation.v1"
    var id: String
    var status: AnnotationStatus
    var createdAt: String
    var updatedAt: String
    var readAt: String?
    var clearAfter: String?
    var completionSummary: String?
    var cancelReason: String?
    var source: AnnotationSource
    var selection: AnnotationSelection
    var image: AnnotationImage
    var credit = AnnotationCredit()
}

struct CurrentAnnotationPointer: Codable, Equatable {
    var schema = "dev.kestudios.pen.current.v1"
    var id: String
}

enum PenClock {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func string(_ date: Date = Date()) -> String {
        fractional.string(from: date)
    }

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}

struct CropArtifact {
    var png: Data
    var width: Int
    var height: Int
    var strokeBoundsPoints: CGRect
    var cropRectPixels: CGRect
    var normalizedStrokes: [[PenPoint]]
}

