import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { OpenCode } from './opencode.js';
import { Journal, Workflow } from './workflow.js';
import { VoiceTools } from './voice-tools.js';
import { agentPrompt, voiceTools } from './agent-config.js';

export async function conversationToken({ apiKey, agentID, fetcher = fetch }) {
  if (!apiKey || !agentID) throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env');
  const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/token');
  url.searchParams.set('agent_id', agentID);
  const response = await fetcher(url, { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    // Map known codes to local guidance; never forward raw provider error bodies.
    const guidance = {
      missing_permissions: 'Enable ElevenLabs Agents/Conversational AI write permission (convai_write) for this API key.',
      invalid_api_key: 'Check ELEVENLABS_API_KEY or create a replacement key, then restart the voice bridge.',
    };
    const code = failure?.detail?.status;
    const hint = Object.hasOwn(guidance, code) ? ` ${guidance[code]}` : '';
    throw new Error(`ElevenLabs token request failed (HTTP ${response.status}).${hint}`);
  }
  const data = await response.json();
  if (typeof data.token !== 'string' || !data.token) throw new Error('ElevenLabs returned no conversation token');
  return data.token;
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON body required');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw new Error('Request is too large');
  }
  const result = JSON.parse(body);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('JSON object required');
  return result;
}

/** Loopback-only development harness. Long-lived provider keys stay on this server. */
export function createVoiceServer({ client, workflow, apiKey, agentID, publicOrigin, key = randomBytes(32).toString('hex'), getToken = conversationToken }) {
  const external = publicOrigin ? new URL(publicOrigin) : undefined;
  if (external && (!['http:', 'https:'].includes(external.protocol) || external.username || external.password ||
      external.pathname !== '/' || external.search || external.hash)) {
    throw new Error('VOICE_PUBLIC_ORIGIN must be an HTTP(S) origin without a path, credentials, query, or fragment');
  }
  const rooms = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const host = req.headers.host ?? '';
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host);
      const configured = external?.host === host;
      if (!local && !configured) return send(403, { error: 'Invalid host. Use the printed localhost URL, or set VOICE_PUBLIC_ORIGIN to your forwarded browser origin and restart.' });
      const expectedOrigin = configured ? external.origin : `http://${host}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) return send(403, { error: 'Invalid origin' });
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (path.startsWith('/api/')) {
        const provided = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${key}`);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(401, { error: 'Open the local URL printed by voice:dev' });
        if (req.method === 'GET' && path === '/api/sessions') return send(200, await client.sessions());
        if (req.method === 'GET' && path === '/api/config') return send(200, { prompt: agentPrompt, tools: voiceTools });
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
        const body = await jsonBody(req);
        if (path === '/api/conversation') {
          if (rooms.size >= 4) throw new Error('Too many open conversations; end an existing conversation first');
          const tools = new VoiceTools(client, workflow);
          const selection = await tools.select(body.sessionID);
          const token = await getToken({ apiKey, agentID });
          const roomID = randomUUID();
          rooms.set(roomID, tools);
          return send(200, { token, roomID, selection });
        }
        const tools = rooms.get(body.roomID);
        if (!tools) return send(404, { error: 'Conversation has ended; start a new one' });
        const result = await tools.exclusive(async () => {
          switch (path) {
            case '/api/transcript': tools.recordTranscript(body.transcript); return { ok: true };
            case '/api/tool': return tools.call(body.name, body.args);
            case '/api/poll': return tools.poll();
            case '/api/ack': tools.acknowledge(body.id); return { ok: true };
            case '/api/end': rooms.delete(body.roomID); return { ok: true };
            default: throw new Error('Unknown API route');
          }
        });
        return send(200, result);
      }
      const files = { '/': ['../web/index.html', 'text/html'], '/app.js': ['../.voice-build/app.js', 'text/javascript'], '/style.css': ['../web/style.css', 'text/css'] };
      if (req.method !== 'GET' || !Object.hasOwn(files, path)) return send(404, { error: 'Not found' });
      const [file, type] = files[path];
      const content = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(content);
    } catch (error) {
      if (!res.headersSent) send(400, { error: error.message });
      else res.end();
    }
  });
  return { server, key };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new OpenCode({
    url: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096', directory: process.env.OPENCODE_DIRECTORY,
    username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD,
  });
  const workflow = new Workflow(client, new Journal('.opencode-call/tasks.json'));
  const { server, key } = createVoiceServer({ client, workflow, apiKey: process.env.ELEVENLABS_API_KEY, agentID: process.env.ELEVENLABS_AGENT_ID, publicOrigin: process.env.VOICE_PUBLIC_ORIGIN });
  server.listen(Number(process.env.VOICE_PORT ?? 3210), '127.0.0.1', () => {
    const origin = process.env.VOICE_PUBLIC_ORIGIN ? new URL(process.env.VOICE_PUBLIC_ORIGIN).origin : `http://127.0.0.1:${server.address().port}`;
    console.log(`OpenCode Call voice test: ${origin}/#${key}`);
    console.log('Use one tab. Starting voice uses your configured ElevenLabs account. Ctrl+C stops the bridge.');
  });
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Voice port ${process.env.VOICE_PORT ?? 3210} is already in use. Stop the previous voice:dev process with Ctrl+C, or choose another port, for example: VOICE_PORT=3220 npm run voice:dev`);
      console.error('In a dev container, forward the new port too. If VOICE_PUBLIC_ORIGIN is set, update it or its proxy mapping to match.');
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
}
