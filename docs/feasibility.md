# Feasibility and implementation gates

Companion to `specification.md`. Requirements are agreed targets, not claims that device behavior has been demonstrated.

## Gate 1 — Ubuntu/OpenCode integration

Initial evidence: the Node integration and CLI are implemented (see
`integration.md`). A live smoke test passed against OpenCode 1.19.4 for schema,
session lifecycle, status/history, pending input, and permission-policy retention.
HTTP fixture tests cover dispatch/reconciliation and control behavior. Model/tool
permission enforcement and the actual remote Ubuntu deployment are not yet proven.

Can be developed in the Linux environment using the target server's actual API contract.

- Inspect the installed server version and `/doc` OpenAPI schema.
- Verify asynchronous prompt submission, status/history retrieval, event observation, permissions/questions, and cancellation.
- Enforce conversation-mode read-only investigation across edits, shell commands, delegation, custom tools, and MCP tools. Do not assume selecting Plan is sufficient.
- Exercise success, failure, permission waits, clarification, cancellation, and reconnect around completion.
- Read recent actions without prompting or disrupting a running build.
- Reconcile server state after disconnects; define duplicate-submission and duplicate-announcement handling. Do not assume durable SSE replay.
- Treat acceptance of a prompt, session idleness, successful completion, and cancellation as distinct outcomes.
- Determine whether a companion service is necessary before introducing one.

## Gate 2 — Apple tooling

Native SwiftUI source and an XcodeGen definition are now in `ios/`. The native
client talks directly to OpenCode/ElevenLabs and keeps credentials in Keychain.
See `ios/README.md` for first-build instructions. The Linux environment has no
Swift compiler or iOS SDK; native compilation, Swift tests, and device behavior
remain unverified until the Mac build.

- Obtain the old Mac model, macOS version, and supported Xcode versions.
- Verify compatibility with the user's iPhone OS and selected ElevenLabs SDK release.
- Attempt physical-device development signing using a free Apple Account. Free provisioning has limitations and generally requires reinstallation after seven days.
- If the Mac cannot run suitable tooling, resolve access to compatible Apple hardware/build tooling before promising device validation. Linux containers cannot supply macOS/Xcode.

## Gate 3 — Locked-phone audio (highest product risk)

Use a physical iPhone and AirPods without an attached debugger for background tests.

1. Start an explicit voice session, lock the phone, and enter a quiet build phase.
2. Test 1, 5, 15, and 30 minute waits, then longer waits. These are test durations, not product caps.
3. Deliver completion, speak exactly once, and resume conversational input without unlocking.
4. Compare conversational mute, stopped transmission, and stopped hardware capture. Measure actual microphone/transmission behavior.
5. Repeat with ElevenLabs disconnected during the wait and reconnected for completion.
6. Test incoming calls, Siri, AirPods disconnect/reconnect, and Wi-Fi/cellular/Tailscale transitions.

An active audio-session object, network connection, or mute setting does not itself prove continued background execution. Do not use silent playback solely to evade suspension. Regular manual reopening after each build fails the core requirement.

## Gate 4 — Wake activation and other audio

- Verify on-device wake detection with locked phone and music playing, including false activations and battery impact.
- Verify ordinary surrounding speech is not transmitted to ElevenLabs during quiet builds.
- Determine which explicit headset/system controls are actually available as fallback.
- Test Spotify and other audio for pause/resume or accepted volume-reduction behavior across a full exchange.
- Verify completion, blockers, and reminders can take audio priority and release it afterward.
- Ensure headset loss does not unexpectedly broadcast speech over the phone speaker.

## Gate 5 — ElevenLabs conversation lifecycle

Initial implementation: a browser WebRTC voice harness, client-tool bridge,
short-lived conversation token exchange, and explicit-transcript authorization
are available (see `voice-setup.md`). Automated tests cover mocked provider token
exchange and local HTTP/tool behavior. No real ElevenLabs voice call, iOS SDK,
or background-audio behavior has yet been validated.

- Pin and validate a Swift SDK version; documentation and repository examples may differ.
- Validate client-tool handling, context updates, speech initiation, interruption, mute semantics, timeouts, and reconnection.
- Current researched documentation allows a maximum individual conversation duration of 7,200 seconds. Verify this at implementation time; preserve app context across fresh conversations instead of imposing an app-session cap.
- Do not leave a tool request pending for an arbitrarily long build without testing timeout behavior.
- Context updates alone are not assumed to trigger speech.
- Verify English/Danish switching, mixed technical language, negation, ambiguous authorization, and natural interruption.
- Verify replay of stored reports and configurable reminder behavior.

## Gate 6 — Recovery and credentials

- Choose secure ElevenLabs authentication without assuming cloud tools can reach a private tailnet.
- Verify Tailscale reconnection and host availability independently of iOS app execution.
- Design exceptional-case notifications explicitly; neither SSE nor Tailscale guarantees delivery to a suspended app.
- Validate persisted context, history deletion, credential storage, and service-side retention choices.

## Primary references

- OpenCode server: https://opencode.ai/docs/server/
- OpenCode permissions: https://opencode.ai/docs/permissions/
- OpenCode agents: https://opencode.ai/docs/agents/
- Apple play-and-record audio session: https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord
- Apple background execution: https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time
- ElevenLabs Swift SDK: https://elevenlabs.io/docs/agents-platform/libraries/swift
- ElevenLabs SDK repository: https://github.com/elevenlabs/elevenlabs-swift-sdk
- ElevenLabs conversation flow: https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow
- Tailscale Serve: https://tailscale.com/kb/1312/serve
- Tailscale iOS VPN On Demand: https://tailscale.com/kb/1291/ios-vpn-on-demand
