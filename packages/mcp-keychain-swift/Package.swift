// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "mcp-keychain-swift",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "mcp-keychain-swift",
            dependencies: [],
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("Foundation")
            ]
        ),
    ]
)
