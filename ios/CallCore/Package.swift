// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CallCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "CallCore", targets: ["CallCore"])],
    targets: [
        .target(name: "CallCore"),
        .testTarget(name: "CallCoreTests", dependencies: ["CallCore"])
    ]
)
