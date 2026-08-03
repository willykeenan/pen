// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "KEPen",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "KEPenApp", targets: ["KEPenApp"])
    ],
    targets: [
        .target(
            name: "KEPenCore",
            path: "Sources/KEPenApp"
        ),
        .executableTarget(
            name: "KEPenApp",
            dependencies: ["KEPenCore"],
            path: "Sources/KEPenEntry"
        ),
        .testTarget(
            name: "KEPenAppTests",
            dependencies: ["KEPenCore"],
            path: "Tests/KEPenAppTests"
        )
    ]
)
