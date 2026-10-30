# Native iPhone app — first device-test build

SwiftUI iOS 17+ application. It connects **directly** to OpenCode and ElevenLabs;
the Node/browser bridge is not required. Users bring their own ElevenLabs account,
configured agent, API key, and agent ID. Settings are stored in iOS Keychain.

## Current status

Native source and an XcodeGen project definition are ready for a first Mac build.
**This Linux environment has no Swift compiler, Xcode, or iOS SDK. The native app
has not been compiled or run on a simulator/device here.** SDK call signatures
were checked against ElevenLabs Swift SDK tag `v3.4.0`.

Implemented: connection settings, session selection, voice and typed replies,
proposal authorization, cancellation, progress, pending permissions/questions,
separate restricted investigation, completion polling, and a persistent task journal.
The authorization vocabulary and client-tool names match the browser prototype.

Background audio is declared for experiments. Wake phrases, automatic long-session
reconnection, reminder settings, durable voice history, and reliable music
pause/resume are not implemented. Device disconnection or audio interruption ends
voice explicitly; PC work continues. There is no app-imposed duration timer.

## What the Mac needs

- An Xcode version compatible with your installed iPhone iOS version. The package
  manifest's Swift 5.9 minimum does **not** establish support for your iOS 26 phone.
  Check Apple's Xcode support table: https://developer.apple.com/support/xcode/
- A free Apple Account for an initial personally signed device build.
- XcodeGen (`brew install xcodegen` if Homebrew is available).

Check **Apple menu → About This Mac** for its model/year and macOS version. An old
Mac may not support the Xcode version required by the phone. Resolve that before
spending time on dependency or signing errors.

## Generate and open the project on the Mac

Get this repository onto the Mac, then from its root:

```sh
xcodegen generate --spec ios/project.yml
open ios/OpenCodeCall.xcodeproj
```

The generated project and Info.plist are build outputs; edit `project.yml` instead.
Packages pin ElevenLabs 3.4.0 and LiveKit 2.10.0. Transitive packages are resolved
by Xcode; save/review the resolved versions after the first successful build.

1. Wait for Swift package resolution.
2. Select the **OpenCodeCall** target → **Signing & Capabilities**.
3. Choose your Personal Team and change the bundle identifier to a unique value
   (persist your preferred identifier in `project.yml` before future generation).
4. Connect your iPhone by cable, trust the Mac, and enable Developer Mode if asked.
5. Select the iPhone as run destination and press **Run**.

Free provisioning generally expires after seven days; re-run from Xcode to renew.
No paid membership is needed for this initial local device test. TestFlight needs
paid membership and is not set up in this repository.

## Tests and build commands (Mac)

```sh
swift test --package-path ios/CallCore
xcodebuild -project ios/OpenCodeCall.xcodeproj -scheme OpenCodeCall \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Core tests exercise authorization and HTTP behavior without a model or ElevenLabs
charges. Only an actual device run can validate AirPods, microphone permission,
route interruption, and locked-screen execution.

## Configure the app

In **Settings**, enter:

- OpenCode's address reachable **from the iPhone**, preferably its private Tailscale
  HTTPS origin; `localhost` on the phone points to the phone itself.
- Absolute project directory on Ubuntu, plus OpenCode username/password if enabled.
- Your own ElevenLabs API key (`convai_write` enabled) and agent ID.

Reuse the existing ElevenLabs client tools from `npm run voice:config`. Replace the
last desktop-prototype sentence in the agent prompt with: “This is the native iOS
test client; background audio and wake activation are not yet verified.” The app
does not modify your hosted agent automatically.

The app exchanges your user-entered key for a short-lived token on-device; no
shared developer API key is bundled. HTTPS is required for remote endpoints.
Local-network ATS access is enabled, but arbitrary HTTP exceptions are not. Use
Tailscale Serve HTTPS rather than weakening transport security for a raw IP URL.

For out-of-house operation, Ubuntu and iPhone still need working network access,
such as Tailscale on both devices. Skipping the browser LTE test does not remove
that requirement. Tailscale Serve should proxy **OpenCode (4096)** for this native
client, not the browser bridge (3210). Keep Ubuntu awake and OpenCode running.

## First device test

1. Save settings, load sessions, and start voice with AirPods connected.
2. Ask for progress and verify it matches OpenCode.
3. Ask the agent to propose a small task. Say “okay”: it must not start.
4. Say “start building” or “gå i gang med at bygge”: one task should start.
5. Use **Resume conversation** during the build to ask for status.
6. Hear the completion report; verify follow-up discussion starts no new task.
7. Test a permission request, cancellation, and recovery after ending/restarting voice.
8. Then test screen locking for 1, 5, and 15 minutes, AirPods removal, incoming
   calls, and Wi-Fi-to-cellular transitions. Record actual behavior rather than
   assuming the background audio declaration guarantees execution.

Current completion acknowledgement records successful SDK submission, not proof
that speech was heard. Reports/history are limited for display; long sessions will
need pagination and bounded retention. A separate investigation uses server-side
default-deny permissions; adversarial tool enforcement is still a feasibility gate.
