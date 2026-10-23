# OpenCode Call — product specification

Status: scope confirmed by the user; first Ubuntu integration milestone underway.

## Goal

A personal iOS voice client for an existing OpenCode server on Ubuntu. The user can discuss work, authorize an agreed task, and hear results through AirPods while away from the computer. Tailscale provides private access to OpenCode. ElevenLabs Agents provides natural, interruptible Danish/English conversation.

## Environment and development

- Main development environment: this Linux development container.
- OpenCode host: Ubuntu, awake and reachable over Tailscale during use.
- Target application: native Swift/SwiftUI using the ElevenLabs Swift SDK.
- Test equipment reported by the user: iPhone 15, iOS 26.6.2, AirPods Pro 3.
- User has an old Mac; model, macOS version, and compatible Xcode version remain unknown.
- No paid Apple Developer membership. Investigate free Xcode device signing first; TestFlight requires paid membership.
- Begin with documentation and Ubuntu integration work. Physical iPhone audio validation follows when suitable Apple tooling is available.

## Core experience

1. Connect to the PC, choose an OpenCode project/session, and deliberately start voice mode.
2. Discuss a task in English, Danish, or a mixture of both. Respond in the user's most recent language unless instructed otherwise; preserve code identifiers.
3. OpenCode can investigate the project under enforced read-only restrictions to inform the discussion.
4. A clear instruction authorizes one agreed task: for example, “start building,” “implement that,” or “gå i gang med at bygge.”
5. OpenCode implements and verifies the task. The voice interface normally becomes quiet while work runs.
6. On completion, the voice agent identifies the project/task and gives a roughly 15–30 second summary of changes, checks, blockers, and limitations, then invites a response.
7. Return to conversation mode. Further implementation requires fresh authorization.

Locked-phone use through AirPods during a deliberately started voice session is a core requirement, subject to the feasibility gates in `feasibility.md`.

## Roles and authorization

- OpenCode owns project inspection, implementation planning, coding, and execution. Use its existing server API.
- A dedicated ElevenLabs Agent owns conversational interaction and explanations, consulting OpenCode when project knowledge is insufficient.
- Conversation mode permits investigation but not project-changing actions. Enforce this through effective server permissions; prompt wording or the default Plan agent alone is insufficient.
- Clear contextual authorization starts only the agreed task. Ambiguous agreement, negation, silence, or an undefined scope must not start work.
- Discussing a follow-up while a build runs records a proposal without changing the running task.
- Tool permission requests and clarification questions interrupt the quiet phase and are presented by voice. Permissions are approved for the individual pending action; unanswered requests remain paused.
- Normal build authorization does not authorize committing, pushing, or creating a pull request. These require explicit requests.
- “Stop talking” stops speech. “Stop building” requests OpenCode cancellation. Bare “stop” immediately silences speech and asks whether to cancel if work is running. Cancellation does not imply rollback.

## Progress, reminders, and context

- Mid-build progress requests read status and recent actions without injecting a new prompt into the active coding turn.
- Summaries distinguish observed activity from verified results and disclose stale information.
- Default unanswered-prompt behavior: one reminder after one minute, then quiet if still unanswered. Reminder count and delay are app settings.
- Reminders repeat the outstanding question, not the whole report. The user can request the full previous report again in either language.
- Preserve the last spoken report so repetition is faithful.
- One selected session receives voice attention. Other sessions accumulate unread updates; switching offers a concise catch-up.
- Context includes selected session, agreed task, recent conversation, current status, blockers, outstanding question, and last report. Fetch additional detail on demand.

## Audio behavior

- Support natural interruption of spoken responses.
- During builds, pause transmission and interpretation of conversational microphone audio. Hardware capture need not be off if an active audio path is required; show truthful microphone state.
- Target an on-device wake phrase, such as “Hey OpenCode,” for summoning conversation during builds. Local wake detection may remain active; ordinary surrounding speech should not be sent to ElevenLabs.
- If wake detection is unreliable, an explicitly verified headset/system/app activation control is acceptable as an initial fallback.
- Pause microphone capture and spoken output when AirPods disconnect; do not automatically switch to the phone speaker. Resume through reconnected headphones or explicit phone-audio selection.
- Let music/other audio play during quiet phases. Give the whole conversational exchange priority, including user replies. Prefer pause/resume where supported; temporary volume reduction is an accepted fallback.
- Completion reports, blockers, and configured reminders may interrupt music automatically. Routine progress stays silent unless requested.

## Session lifecycle and reliability

- No app-imposed session-duration cap. The app session outlives individual ElevenLabs conversations.
- Carry context across voice-service reconnects. Reconnect quietly when possible and explain noticeable interruptions.
- Aim to disconnect unused ElevenLabs conversations during long builds if this preserves the required background experience.
- Authorized PC work continues if the phone disconnects or closes. Reconcile status/history on return; avoid duplicate submissions and duplicate completion reports.
- Exceptional iOS suspension, calls, or unrecoverable network interruption may require a notification and explicit voice resumption. Notification delivery is not yet architected. Routine manual reopening after builds fails the core experience.
- Reopening restores workspace/context but does not automatically enable the microphone or speak.

## Networking and setup

- Keep OpenCode private to the Tailscale network. The iPhone connects separately to ElevenLabs over the internet.
- Initial settings accept the Tailscale host address, required OpenCode credentials, and ElevenLabs agent configuration. Exact credential fields depend on the verified authentication architecture.
- Store credentials securely and provide a connection test.
- A small Ubuntu companion service is acceptable only where needed for authentication, notifications, or coordination; it does not replace the OpenCode server.

## App interface and history

- Session/project selection, readable conversation and task status, typed replies, voice controls, and settings.
- Visible controls for starting/ending voice mode, requesting progress, authorizing the agreed build, and cancelling active work.
- Persist text transcripts and spoken reports, with deletion controls. Do not persist raw microphone audio in the app. ElevenLabs retention is configured separately.

## First end-to-end acceptance scenario

On a different network from the Ubuntu host, select a session, start voice mode, lock the iPhone, and continue through AirPods. Discuss a small change in either supported language and explicitly authorize it. OpenCode implements and runs checks. Hear a truthful completion report through ElevenLabs and discuss follow-up work. No additional implementation occurs without new authorization.

## Remaining decisions

- Check old Mac compatibility with an Xcode/iOS SDK suitable for the test phone.
- Verify installed OpenCode API/version and effective permissions.
- Choose authentication, companion-service needs, notification mechanism, and persistence architecture based on feasibility evidence.
- Establish exact silence timeout before considering a prompt unanswered, and reminder-delay timing semantics.
- Validate wake phrase/control implementation and audio routing behavior on device.
