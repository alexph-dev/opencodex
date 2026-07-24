// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodexMenuBar", targets: ["MenuBarApp"]),
        .executable(name: "MenuBarCoreTests", targets: ["MenuBarCoreTests"]),
        .executable(name: "UIProbe", targets: ["UIProbe"]),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        // AppKit views live in a library so both the app and the visual-QA probe can
        // build the same surface. An executable target cannot be imported.
        .target(name: "MenuBarUI", dependencies: ["MenuBarCore"], path: "Sources/MenuBarUI"),
        .executableTarget(
            name: "MenuBarApp",
            dependencies: ["MenuBarCore", "MenuBarUI"],
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
        .executableTarget(name: "UIProbe", dependencies: ["MenuBarCore", "MenuBarUI"], path: "Sources/UIProbe"),
    ],
    swiftLanguageVersions: [.v5]
)
