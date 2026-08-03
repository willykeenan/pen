import Foundation

enum AnnotationStoreError: Error, LocalizedError {
    case invalidIdentifier
    case missingCurrentAnnotation

    var errorDescription: String? {
        switch self {
        case .invalidIdentifier: return "Pen refused an invalid annotation identifier."
        case .missingCurrentAnnotation: return "The current Pen annotation no longer exists."
        }
    }
}

final class AnnotationStore {
    let root: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(root: URL = AnnotationStore.defaultRoot(), fileManager: FileManager = .default) {
        self.root = root.standardizedFileURL
        self.fileManager = fileManager
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    }

    static func defaultRoot(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let configured = environment["KE_PEN_HOME"], !configured.isEmpty {
            return URL(fileURLWithPath: NSString(string: configured).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/KE Pen", isDirectory: true)
    }

    func prepare() throws {
        try createPrivateDirectory(root)
        try createPrivateDirectory(root.appendingPathComponent("annotations", isDirectory: true))
    }

    func save(
        artifact: CropArtifact,
        source: AnnotationSource
    ) throws -> AnnotationRecord {
        try prepare()
        let id = UUID().uuidString.lowercased()
        let directory = try annotationDirectory(id: id)
        try createPrivateDirectory(directory)

        let imageURL = directory.appendingPathComponent("crop.png", isDirectory: false)
        try artifact.png.write(to: imageURL, options: .atomic)
        try makePrivate(imageURL)

        let now = PenClock.string()
        let record = AnnotationRecord(
            id: id,
            status: .pending,
            createdAt: now,
            updatedAt: now,
            source: source,
            selection: AnnotationSelection(
                strokeBoundsPoints: PenRect(artifact.strokeBoundsPoints),
                cropRectPixels: PenRect(artifact.cropRectPixels),
                normalizedStrokes: artifact.normalizedStrokes,
                coordinateNote: "Normalized stroke coordinates use a top-left origin inside the returned crop."
            ),
            image: AnnotationImage(
                file: "crop.png",
                mimeType: "image/png",
                width: artifact.width,
                height: artifact.height,
                sha256: CaptureCropper.sha256(artifact.png),
                includesInk: true
            )
        )

        try write(record)
        let pointer = CurrentAnnotationPointer(id: id)
        try writeJSON(pointer, to: root.appendingPathComponent("current.json"))
        return record
    }

    func current() throws -> AnnotationRecord? {
        let pointerURL = root.appendingPathComponent("current.json")
        guard fileManager.fileExists(atPath: pointerURL.path) else { return nil }
        let pointer = try decoder.decode(CurrentAnnotationPointer.self, from: Data(contentsOf: pointerURL))
        return try read(id: pointer.id)
    }

    func read(id: String) throws -> AnnotationRecord {
        let url = try annotationDirectory(id: id).appendingPathComponent("annotation.json")
        guard fileManager.fileExists(atPath: url.path) else {
            throw AnnotationStoreError.missingCurrentAnnotation
        }
        return try decoder.decode(AnnotationRecord.self, from: Data(contentsOf: url))
    }

    func write(_ record: AnnotationRecord) throws {
        let url = try annotationDirectory(id: record.id).appendingPathComponent("annotation.json")
        try writeJSON(record, to: url)
    }

    func setStatus(
        id: String,
        status: AnnotationStatus,
        cancelReason: String? = nil
    ) throws {
        var record = try read(id: id)
        record.status = status
        record.updatedAt = PenClock.string()
        record.cancelReason = cancelReason
        try write(record)
    }

    func cancelOrphanedCurrent() {
        guard var record = try? current(),
              [.pending, .reading, .completing].contains(record.status)
        else { return }
        record.status = .cancelled
        record.cancelReason = "Native overlay restarted before completion."
        record.updatedAt = PenClock.string()
        try? write(record)
    }

    func clearHistory() throws {
        let annotations = root.appendingPathComponent("annotations", isDirectory: true)
        if fileManager.fileExists(atPath: annotations.path) {
            try fileManager.removeItem(at: annotations)
        }
        let pointer = root.appendingPathComponent("current.json")
        if fileManager.fileExists(atPath: pointer.path) {
            try fileManager.removeItem(at: pointer)
        }
        try prepare()
    }

    private func annotationDirectory(id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw AnnotationStoreError.invalidIdentifier }
        return root
            .appendingPathComponent("annotations", isDirectory: true)
            .appendingPathComponent(id.lowercased(), isDirectory: true)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        try createPrivateDirectory(url.deletingLastPathComponent())
        let data = try encoder.encode(value)
        try data.write(to: url, options: .atomic)
        try makePrivate(url)
    }

    private func createPrivateDirectory(_ url: URL) throws {
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func makePrivate(_ url: URL) throws {
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

