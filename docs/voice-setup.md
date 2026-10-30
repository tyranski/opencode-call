# ElevenLabs voice test client

This milestone connects a browser microphone to **ElevenLabs Agents using WebRTC**.
The agent's client tools call the local Node bridge, which calls OpenCode. The
ElevenLabs cloud does not need inbound access to the private Tailscale server.

## 1. Configure a dedicated ElevenLabs Agent

In the ElevenLabs dashboard, create a dedicated conversational agent. Enable
authentication (private agent). Choose your preferred voice, enable English and
Danish in its language settings, and enable natural interruptions.

Get the supplied system prompt and client-tool definitions:

```sh
npm run voice:config
```

The JSON output has two keys: `prompt` and `tools`. Copy `prompt` into the agent's
system prompt. For each entry in `tools`, add a **Client** tool in the dashboard,
using the matching name, description, and parameter schema. If the dashboard has
a JSON editor, paste that individual tool object. Enable **Wait for response**
(`expects_response: true`). This output is a setup manifest, not a full agent
configuration to upload over an existing agent.

| Tool | Purpose |
| --- | --- |
| `get_progress` | Current state, recent actions, last report, and pending input |
| `propose_task` | Record and read back task scope without starting work |
| `start_build` | Authorize the latest proposal from a new explicit user transcript |
| `cancel_build` | Cancel the build started through this bridge |
| `investigate` | Start a separate restricted investigation |
| `investigation_result` | Read that investigation's latest result |
| `reply_permission` | Approve once or reject one pending permission |
| `answer_question` | Pass through the user's answer to a single pending question |
| `repeat_update` | Retrieve the last acknowledged OpenCode update |

Enable the agent's client events for `user_transcript`, `agent_response`,
`client_tool_call`, and interruptions. Without user transcript events the bridge
will refuse voice authorization. Tool names and parameters are case-sensitive.

No hosted agent or tool configuration is changed automatically by this repository.

## 2. Configure local credentials

Copy `.env.example` to `.env` and fill in:

- `OPENCODE_URL`: OpenCode HTTP endpoint, or private Tailscale HTTPS endpoint.
- `OPENCODE_DIRECTORY`: absolute project path on the OpenCode host.
- `OPENCODE_SERVER_PASSWORD` and optionally username if required.
- `ELEVENLABS_API_KEY`: server-side ElevenLabs key with Agents/Conversational AI
  **write** permission (`convai_write`), required to obtain conversation tokens.
- `ELEVENLABS_AGENT_ID`: dedicated agent ID from the dashboard.

Run:

```sh
npm ci
npm run voice:dev
```

Open the printed `http://127.0.0.1:3210/#...` URL. The fragment is a randomly
generated local bridge credential, removed from the address bar after page load
and retained in this browser tab's session storage so refresh works. After
restarting the bridge, open its newly printed URL to replace the old key. Do not
share it. The bridge binds only
to loopback, requires that credential on API requests, and rejects cross-origin
requests. It is a local single-user development harness, not a deployed mobile API.

For a dev container, forward port 3210 and use the host's browser for microphone
access. Remapped localhost ports are supported: use the browser's forwarded port
and preserve the printed `#` fragment. For an HTTPS forwarding hostname, set
`VOICE_PUBLIC_ORIGIN=https://your-exact-forwarded-host` in `.env`, then restart
`npm run voice:dev`. Supply only the origin, without a path or fragment. The printed
URL will use it, and only that additional hostname/origin is accepted. Keep the
forwarded port private. This remains a single-user test harness, not a production
deployment authentication design. Use one browser tab.

The bridge exchanges the API key for a short-lived WebRTC conversation token. The
browser receives that token, never the long-lived ElevenLabs or OpenCode keys.
Network token requests are time-limited and provider error bodies are not exposed.
The SDK version is pinned; LiveKit is pinned to 2.22.0 to remain compatible with
the development container's Node 22.16 runtime.

## 3. Exercise the workflow

1. Load sessions, select one, and start voice. Allow browser microphone access.
2. Ask what OpenCode is doing. Observe that progress does not inject a new coding prompt.
3. Discuss a small change and ask the assistant to propose it. Check the visible task.
4. Say “okay”: no build should start.
5. Say “start building” or “gå i gang med at bygge”: the proposal is submitted once.
6. The browser mutes conversational microphone transmission during the build.
   Click **Resume conversation** to talk during work, or **Ask for progress**.
   There is no wake-word implementation yet.
7. When work finishes or needs input, a polling update prompts the agent to speak.
   Automatic build muting is lifted, but a manual microphone mute is respected.
8. Ask to repeat the update, discuss follow-up work, or explicitly start a new proposal.

Typed replies use the same authorization checks. Transcripts and tool errors are
displayed as plain text. Ending voice does not stop the PC build.

### Microphone access denied

Sessions load automatically when the page opens. If Start voice fails with
microphone permission denied, use the browser's site settings (beside the address
bar) to set Microphone to **Allow** for this exact origin, then try again. Open a
regular browser tab rather than an embedded VS Code preview. Microphone access
requires localhost or HTTPS. Also check the selected input device in Ubuntu's
Sound settings. The app now labels the startup stage so microphone failures can
be distinguished from ElevenLabs authentication or voice-connection errors.

### ElevenLabs HTTP 401: missing permissions

If the error identifies `convai_write`, edit the API key's permissions in ElevenLabs
and enable write access for Agents/Conversational AI. If you create a replacement
key, update `ELEVENLABS_API_KEY` in `.env`, restart `npm run voice:dev`, and open
the newly printed URL. Read-only Agents access is insufficient for the WebRTC
conversation-token endpoint.

## Authorization boundary

The bridge accepts user transcripts through a separate authenticated endpoint,
not through tool arguments. A build instruction must follow the latest proposal,
be less than one minute old, and be unused. It authorizes only that proposal.
Changing the proposal invalidates earlier authorization. Synthetic `APP_UPDATE`
messages are not recorded as user authorization by the application.

This prototype deliberately uses exact normalized phrases:

- Build: `start building`, `start the build`, `implement that`,
  `gå i gang med at bygge`, `gå i gang med det`, `begynd at bygge`.
- Cancel: `stop building`, `cancel the build`, `stop med at bygge`, `annuller byggeriet`.
- Permission: `approve once`, `godkend én gang` / `godkend en gang`,
  `reject permission`, `afvis tilladelsen`.

Case and trailing sentence punctuation are ignored. Negations, quoted phrases,
conditional instructions, and other paraphrases are rejected and need clarification.
This is not yet the final bilingual semantic-intent implementation.

Permission replies must follow presentation of the pending request. Multiple
simultaneous permissions and multi-question requests currently need resolution in
OpenCode. A single clarification answer must exactly match a fresh user transcript.
User transcript delivery failure blocks tools rather than falling back to agent
claims of authorization. End and restart voice after such a failure.

The trusted boundary includes the local browser and user. This is not a signed
server-side transcript attestation system; it protects against the agent inventing
approval, not a malicious user of the authenticated browser.

## Completion and recovery limits

- Polling runs every three seconds while the voice conversation is active.
- Terminal assistant messages supply completion evidence; idle by itself does not.
- Updates remain pending until the browser acknowledges queuing them to ElevenLabs.
  That acknowledgement does not prove audible playback. In-tab IDs avoid repeated
  enqueueing; exactly-once delivery across crashes/reloads is not implemented.
- Desktop-started session completions are observed too. Already-finished historical
  messages are not announced automatically on connection; ask for progress to catch up.
- `repeat_update` returns the previous underlying report, not a recording or exact
  transcript of the agent's spoken paraphrase. Long reports are bounded to 16,000 characters.
- Build submissions persist in `.opencode-call/tasks.json`; conversation transcripts,
  authorization evidence, and update acknowledgements are in memory in this milestone.
- On voice disconnection, explicitly start voice again. Context carryover, reminders,
  notification delivery, and voice reconnection across provider duration limits remain
  to implement. The UI imposes no timer-based cap itself.
- Closing a tab abruptly may leave a bridge room allocated; restarting the development
  bridge clears orphaned rooms without clearing the task journal.
- No iOS background behavior, AirPods route handling, wake detection, or cross-app
  music control is established by the browser prototype.

Automated tests use mocked ElevenLabs token responses and real local bridge HTTP
requests. A paid-provider conversation and audio behavior require manual validation
with your configured ElevenLabs account; no live voice call was made during setup.

References: [JavaScript SDK](https://elevenlabs.io/docs/agents-platform/libraries/java-script),
[client tools](https://elevenlabs.io/docs/agents-platform/customization/tools/client-tools),
[WebRTC token](https://elevenlabs.io/docs/api-reference/conversations/get-webrtc-token).
