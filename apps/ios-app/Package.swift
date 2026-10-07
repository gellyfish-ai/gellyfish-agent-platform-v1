// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GellyfishApp",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .executable(name: "GellyfishApp", targets: ["GellyfishApp"])
    ],
    targets: [
        .executableTarget(
            name: "GellyfishApp",
            path: "Sources",
            resources: [
                .process("../Resources")
            ]
        )
    ]
)
