# First integration milestone

## Shape

This milestone is a Node.js 22 library and diagnostic CLI, runnable in the existing
Linux container. It has no third-party runtime dependencies and starts no public
service. It establishes the OpenCode boundary for a future iOS client or justified
Ubuntu companion service; it does not replace OpenCode's server.

- `src/opencode.js`: HTTP authentication, project/session discovery, snapshots,
  SSE observation/reconnection, scoped permission/question replies, and observed
  recent tool activity.
- `src/workflow.js`: task proposal, explicit structured authorization, durable
  single-process submission journal, reconciliation, cancellation, and separate
  restricted investigation sessions.
- `src/cli.js`: read-only server inspection, session listing, progress, and watch.

## Connection

OpenCode's standalone server can run on Ubuntu:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Set `OPENCODE_SERVER_PASSWORD` in the server environment to enable Basic auth,
and supply the same credential in the client's environment. Do not embed secrets
in URLs or commit them. The default username is `opencode`.

For private remote access, Tailscale Serve can proxy the loopback HTTP server over
tailnet HTTPS. Set `OPENCODE_URL` to that endpoint and
`OPENCODE_DIRECTORY` to the project's absolute Ubuntu path. This milestone does
not configure Tailscale automatically.

If you already run the OpenCode TUI, connect to its server address or attach the
TUI to a deliberately started server. Starting `opencode serve` creates another
server; it does not attach to an existing TUI process.

`npm run opencode:inspect` checks health and required endpoint presence in `/doc`.
It does not certify every schema field or server-side permission behavior.

## Task controller usage

Use from a Node.js module at the repository root:

```js
import { OpenCode } from './src/opencode.js';
import { Journal, Workflow } from './src/workflow.js';

const client = new OpenCode({
  url: process.env.OPENCODE_URL,
  directory: process.env.OPENCODE_DIRECTORY,
  password: process.env.OPENCODE_SERVER_PASSWORD,
});
const workflow = new Workflow(client, new Journal('.opencode-call/tasks.json'));
const task = workflow.propose('ses_your_session', 'The exact task agreed with the user');

// Call only in response to an explicit user authorization of this exact proposal.
await workflow.authorize(task.id, { confirmed: true });

// Poll or invoke after relevant events/reconnection:
const current = await workflow.reconcile(task.id);
// Explicit user cancellation:
// await workflow.cancel(task.id);
```

This structured API does not classify English/Danish speech. The future voice
layer must resolve negation, ambiguity, and scope before it calls `authorize`.
Proposals are immutable; a revised plan gets a new proposal ID.

The journal is scoped by server origin and project directory. Use one owning
process and one `Journal` instance per journal file. It is not a multiprocess
database. Task text and reports are stored locally with restricted file modes;
the default suggested directory is gitignored.

The controller writes a message ID and dispatch state before submitting. A failed
or interrupted submission is never automatically retried. Reconciliation matches
that ID in session history. If acceptance cannot be established, the task remains
`uncertain` and blocks another local dispatch into that session. Inspect server
history before manually resolving an uncertain task; do not delete the journal
as a retry mechanism.

`finished` means a correlated assistant turn ended, not that the implementation
is correct or every check passed. The report retains the assistant's account.
Idleness and intermediate tool-call messages alone cannot finish a task.

Cancellation checks that the task is still the latest user turn before aborting
the session. The server abort API is session-wide, so simultaneous desktop/client
actions can still race; this is not a distributed lock or transactional guarantee.
An abort response is not a rollback guarantee.

## Investigation and pending input

`investigate(client, question)` creates a separate session with a wildcard deny
policy and allows only built-in `read`, `glob`, `grep`, and `list` permissions.
It checks the returned policy before submitting to `plan`. It does not change the
permissions of a user's existing build session, and cannot interrupt its prompt.
The investigation prompt must include any relevant conversational context; that
context is not automatically copied from the selected session yet.

The real-server smoke test confirms policy retention. **Adversarial model/tool
execution is still needed to establish actual enforcement** on the target server,
including project/global overrides and custom tools. No claim of sandbox isolation
is made. Git commit/push restrictions in the build prompt are instructions, not
a separate enforced capability boundary yet.

`replyPermission(sessionID, requestID, 'once' | 'reject')` validates pending-session
ownership and intentionally excludes persistent approval. `replyQuestion` accepts
one array of strings for each pending question. A stale request is rejected by
the client or server. Progress snapshots include outstanding permissions/questions
so the future voice layer can resume conversation.

## Verification and remaining work

Verified with HTTP fixture integration tests and a real OpenCode **1.19.4** server:

- Session creation/discovery, schema availability, status, message history, pending
  input endpoints, and retention of session permissions (real server).
- Explicit authorization, duplicate/concurrent submission protection, restart
  recovery after uncertain dispatch, correlated completion, cancellation, scoped
  permission/question responses, SSE parsing and reconnect reconciliation (fixtures).

The live smoke test sends no model prompts. End-to-end model execution, strict
permission enforcement, and the user's actual Ubuntu/Tailscale deployment remain
to validate. Snapshots fetch full message history for correctness; pagination,
event batching, and bounded memory will be needed for very long production sessions.
SSE reconnects after closure/errors; heartbeat-based detection of a silently stalled
connection remains to add. The CLI does not yet generate conversational summaries.

A browser voice harness now adds ElevenLabs client tools, server-side conversation
token exchange, explicit phrase authorization, and in-tab completion updates. See
`voice-setup.md` for setup and its current boundaries.

Remaining product layers: broader semantic authorization, reminders and durable
completion-delivery records, SwiftUI, credentials/history UI, and physical-device
background-audio/wake/music experiments. See `feasibility.md`.
