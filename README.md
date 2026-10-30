# opencode-call
Conversational AI client mobile app for conversations with your OpenCode server. 

## Project status

**Native iPhone app:** SwiftUI source, the direct OpenCode/ElevenLabs integration,
and the Xcode project definition are in [`ios/`](ios/README.md). Follow that guide
for the first Mac build and iPhone test. The native app does not need the browser bridge.

The [product specification](docs/specification.md) records the agreed iOS/AirPods
experience. [Feasibility gates](docs/feasibility.md) track the device behaviors still
to prove. The implementation includes a Node.js 22 OpenCode integration library,
diagnostic CLI, and a browser-based ElevenLabs Agents voice test client. The native
SwiftUI app and physical-device audio validation come next.

## Start the OpenCode server first

The voice app connects to an existing OpenCode server; `npm run voice:dev` does
not start that server for you.

### Terminal 1 — OpenCode server

Open a terminal in the project you want OpenCode to work on and run:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Leave this terminal running. For the simplest development-container setup, run
both OpenCode and the voice app inside the same container. `127.0.0.1` inside a
container does not generally refer to the Ubuntu host.

### Terminal 2 — connect the voice app

Open another terminal at this repository's root. Copy `.env.example` to `.env`
if you have not already created it, then configure:

```dotenv
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_DIRECTORY=/workspaces/opencode-call
```

The directory above is this repository's path inside the development container.
Replace it with the absolute project path **on the OpenCode server** if you want
to work on a different project. Keep your ElevenLabs API key and agent ID in this
same `.env` file as described below.

Check that the server is reachable before starting the voice app:

```sh
node --env-file=.env src/cli.js inspect
node --env-file=.env src/cli.js sessions
```

If no sessions appear, use another terminal to attach to the server:

```sh
opencode attach http://127.0.0.1:4096 --dir /workspaces/opencode-call
```

Use `/connect` if your coding-model provider is not configured, then start a
conversation in the intended project so a session is available to select.
Replace the `--dir` path when using a different project.

**Optional server authentication:** `OPENCODE_SERVER_USERNAME` defaults to
`opencode`. To protect the server with a password, set `OPENCODE_SERVER_PASSWORD`
in Terminal 1's environment **before** running `opencode serve`, and put the same
password in the voice app's `.env`. These are OpenCode server credentials, not
your Ubuntu login. Adding them only to `.env` does not configure an already-running
server. Leave them unset for the initial loopback-only test if authentication is
not enabled on your server.

If port 4096 is already occupied by your intended OpenCode server, use it rather
than starting another instance. An ordinary `opencode` TUI may use a different
server address; attaching to the explicit server above keeps the setup consistent.

## OpenCode integration

Point at your running OpenCode server. `OPENCODE_DIRECTORY` is the absolute path
of the project **on that server**, not necessarily the path on this client.

```sh
export OPENCODE_URL="http://127.0.0.1:4096"
export OPENCODE_DIRECTORY="/absolute/path/to/project"
# If the server uses authentication, also supply OPENCODE_SERVER_PASSWORD.
# OPENCODE_SERVER_USERNAME defaults to opencode.

npm run opencode:inspect
npm run opencode:sessions
npm run opencode:progress -- <session-id>
npm run opencode:watch -- <session-id>
```

Replace `<session-id>` with an ID from `opencode:sessions` (without angle brackets).

These diagnostic commands only read server state. `watch` reconnects and refreshes
state after disconnects; Ctrl+C stops it. For remote use, set the URL to your
private Tailscale endpoint. See [integration details](docs/integration.md) for
the task controller, read-only investigation, limitations, and deployment notes.

## Voice conversation

1. Follow [ElevenLabs setup](docs/voice-setup.md) to configure a dedicated agent,
   including the supplied prompt and client tools.
2. Copy `.env.example` to `.env` and fill in your OpenCode connection,
   `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID`.
3. Start OpenCode and verify the connection using
   [Start the OpenCode server first](#start-the-opencode-server-first). Keep that
   server running. In a separate terminal at this repository's root, run:

   ```sh
   npm ci
   npm run voice:dev
   ```

4. Open the **full local URL printed in the terminal**, including its `#` fragment.
   In a dev container, forward port **3210** to the same local port and use that URL
   in your host browser.
   If the voice port is already in use, stop the earlier voice process or run
   `VOICE_PORT=3220 npm run voice:dev` and forward port **3220** instead. Use the
   newly printed URL after every server restart.
5. Load/select an OpenCode session and click **Start voice**. This connects your
   microphone to ElevenLabs and uses your ElevenLabs account.
6. Discuss a small task. After the agent reads back its proposal, say **“start
   building”** or **“gå i gang med at bygge.”** During a build, click **Resume
   conversation** to speak, or **Ask for progress** for an update. Completion
   updates are sent to the voice agent automatically while the tab is connected.

The bridge keeps long-lived credentials on the server. This is a desktop test
harness; iOS background operation, wake detection, Spotify control, and automatic
voice reconnection are still pending. See [voice setup and limits](docs/voice-setup.md).

## Tests

The Node integration tests require no package installation. Building the browser
voice client requires `npm ci`.

```sh
npm test
npm run voice:build
# Also start a temporary real OpenCode server and validate its API:
OPENCODE_LIVE_TEST=1 npm test
```

The live test requires the `opencode` executable. It creates and deletes one empty
test session; it does not invoke a model. Verified against OpenCode **1.19.4**.

## Development container

The development container includes Node.js 22, npm, Git, and the OpenCode CLI.
It runs as the non-root `node` user with sudo available for installing additional
tools as the project takes shape.

### Open in VS Code

1. Install Docker (Docker Desktop or Docker Engine) and the VS Code **Dev Containers** extension.
2. Open this repository in VS Code.
3. Run **Dev Containers: Reopen in Container** from the command palette.
4. Once the first build finishes, open a terminal in VS Code and run:

   ```sh
   opencode
   ```

5. Use `/connect` inside OpenCode to authenticate with your preferred provider.
   You can then describe the project and start working.

### Open from the command line

With Docker running and the [Dev Container CLI](https://github.com/devcontainers/cli)
installed (`npm install -g @devcontainers/cli`), run these commands from the repository root:

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

Inside that shell, run `opencode` and use `/connect` to authenticate.

### Persistence and updates

- The repository is mounted from your host; edits inside the container appear on the host.
- OpenCode configuration (`~/.config/opencode`) and data (`~/.local/share/opencode`,
  including credentials and sessions) are kept in dedicated Docker volumes for this
  development container. They survive container rebuilds. Removing those volumes
  deletes the saved configuration and data.
- OpenCode is installed from the `opencode-ai` npm package at image build time.
  To fetch the latest version again, run **Dev Containers: Rebuild Container Without Cache**.
- To pin a version, add `"args": { "OPENCODE_VERSION": "<version>" }` to the `build`
  object in `.devcontainer/devcontainer.json`, then rebuild.
