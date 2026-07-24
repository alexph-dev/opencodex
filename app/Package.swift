// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodexMenuBar", targets: ["MenuBarApp"]),
        .executable(name: "MenuBarCoreTests", targets: ["MenuBarCoreTests"]),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        .executableTarget(
            name: "MenuBarApp",
            dependencies: ["MenuBarCore"],
            path: "Sources/MenuBarApp"
        ),
        // An executable rather than a .testTarget: Xcode Command Line Tools ships
        // neither a usable XCTest module nor the swift-testing runtime, so a test bundle
        // cannot run without a full Xcode install. See Sources/MenuBarCoreTests/Harness.swift.
        .executableTarget(
            name: "MenuBarCoreTests",
            dependencies: ["MenuBarCore"],
            path: "Sources/MenuBarCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
