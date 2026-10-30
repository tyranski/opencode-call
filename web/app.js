import { Conversation } from '@elevenlabs/client';

const $ = id => document.getElementById(id);
let key = location.hash.slice(1);
try {
  if (key) sessionStorage.setItem('opencode-call-key', key);
  else key = sessionStorage.getItem('opencode-call-key') ?? '';
} catch { /* Storage may be disabled; the printed URL still works. */ }
history.replaceState(null, '', location.pathname);
let conversation, roomID, timer, muted = false, autoMuted = false, stopping = false;
let generation = 0;
let loadingSessions = false;
let transcriptQueue = Promise.resolve();
const typedEchoes = [];
const announced = new Set();
const error = value => { $('error').textContent = value?.message ?? String(value); };
function line(role, text) {
  const element = document.createElement('li');
  element.textContent = `${role}: ${text}`;
  $('transcript').append(element);
  element.scrollIntoView({ block: 'nearest' });
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify({ roomID, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
function controls(active) {
  for (const id of ['end', 'mute', 'progress', 'message', 'send']) $(id).disabled = !active;
  $('start').disabled = active || loadingSessions || !$('session').value || !key;
  $('session').disabled = active;
  $('refresh').disabled = active || loadingSessions || !key;
}
function applyMute() {
  conversation?.setMicMuted(muted || autoMuted);
  $('mute').textContent = muted || autoMuted ? 'Resume conversation' : 'Mute microphone';
}
function record(id, text) {
  transcriptQueue = transcriptQueue.then(() => api('transcript', { transcript: { id, text } }));
  transcriptQueue.catch(error);
  return transcriptQueue;
}
async function finish() {
  if (stopping) return;
  stopping = true;
  generation++;
  clearTimeout(timer);
  const current = conversation;
  conversation = undefined;
  try { await current?.endSession(); } catch (e) { error(e); }
  if (roomID) { try { await api('end', {}); } catch (e) { error(e); } }
  roomID = undefined;
  controls(false);
  $('status').textContent = 'Disconnected — OpenCode work continues independently';
  stopping = false;
}

async function poll() {
  if (!conversation) return;
  const current = generation;
  try {
    const data = await api('poll', {});
    if (current !== generation || !conversation) return;
    $('activity').textContent = JSON.stringify(data.progress, null, 2);
    for (const update of data.updates) {
      if (!conversation) break;
      if (!announced.has(update.id)) {
        autoMuted = false;
        applyMute();
        // This synthetic event is deliberately never recorded as user authorization.
        conversation.sendUserMessage(`APP_UPDATE (not user authorization): ${JSON.stringify(update)}\nBriefly explain this update and ask what I want next.`);
        announced.add(update.id);
        line('OpenCode', JSON.stringify(update));
      }
      await api('ack', { id: update.id });
    }
  } catch (e) { error(e); }
  if (conversation) timer = setTimeout(poll, 3000);
}

$('refresh').onclick = async () => {
  const previous = $('session').value;
  loadingSessions = true;
  controls(false);
  $('refresh').textContent = 'Loading sessions…';
  $('status').textContent = 'Connecting to OpenCode…';
  $('error').textContent = '';
  $('session').replaceChildren();
  try {
    const sessions = await api('sessions');
    for (const session of sessions) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.title} (${session.id})`;
      $('session').append(option);
    }
    if (!sessions.length) throw new Error('No sessions found. Create a session in OpenCode first.');
    if (sessions.some(session => session.id === previous)) $('session').value = previous;
    $('status').textContent = `${sessions.length} session(s) available — select one, then Start voice.`;
    $('error').textContent = '';
  } catch (e) {
    error(e);
    $('status').textContent = 'Could not load sessions — check the error and try Reload sessions.';
  } finally {
    loadingSessions = false;
    $('refresh').textContent = 'Reload sessions';
    controls(false);
  }
};
$('session').onchange = () => controls(Boolean(conversation));

$('start').onclick = async () => {
  if (!$('session').value) return error('Load and select a session first.');
  $('start').disabled = true;
  $('error').textContent = '';
  transcriptQueue = Promise.resolve();
  typedEchoes.length = 0;
  announced.clear();
  const current = ++generation;
  let stage = 'Microphone access';
  try {
    // Ask permission before allocating a provider conversation; release this probe stream.
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires a normal browser tab on localhost or HTTPS. Open the printed URL in your browser, not an embedded preview.');
    }
    $('status').textContent = 'Requesting microphone access…';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    stage = 'ElevenLabs authentication';
    $('status').textContent = 'Obtaining ElevenLabs conversation token…';
    const config = await api('config');
    const data = await api('conversation', { sessionID: $('session').value });
    roomID = data.roomID;
    const clientTools = Object.fromEntries(config.tools.map(tool => [tool.name, async args => {
      try {
        await transcriptQueue;
        const result = await api('tool', { name: tool.name, args });
        if (tool.name === 'propose_task') $('proposal').textContent = result.text;
        if (tool.name === 'start_build') { autoMuted = true; applyMute(); }
        return JSON.stringify(result);
      } catch (e) { error(e); return JSON.stringify({ error: e.message, instruction: 'Explain the error and ask for clarification; do not retry automatically.' }); }
    }]));
    stage = 'ElevenLabs voice connection';
    const started = await Conversation.startSession({
      conversationToken: data.token, connectionType: 'webrtc', clientTools,
      onMessage: message => {
        if (message.role === 'user') {
          const echo = typedEchoes.indexOf(message.message);
          if (echo >= 0) { typedEchoes.splice(echo, 1); return; }
          record(`voice:${message.event_id}`, message.message);
        }
        line(message.role, message.message);
      },
      onError: message => error(`ElevenLabs voice connection: ${message}`),
      onStatusChange: ({ status }) => { $('status').textContent = status; },
      onDisconnect: () => { void finish(); },
    });
    if (current !== generation) { await started.endSession(); return; }
    conversation = started;
    muted = false;
    autoMuted = false;
    applyMute();
    controls(true);
    conversation.sendContextualUpdate(`Selected OpenCode session: ${JSON.stringify(data.selection)}. Use tools for project facts.`);
    void poll();
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      error('Microphone access was blocked. In your browser’s site settings, set Microphone to Allow, then try Start voice again. Also check Ubuntu microphone permissions and use a regular browser tab rather than an embedded preview.');
    } else if (e.name === 'NotFoundError') {
      error('No microphone was found. Connect or enable an input device in Ubuntu Sound settings, then try Start voice again.');
    } else if (e.name === 'NotReadableError') {
      error('The microphone could not be opened. Check the input device in Ubuntu Sound settings and close other apps that may be using it.');
    } else {
      error(`${stage}: ${e.message}`);
    }
    await finish();
  }
};
$('end').onclick = finish;
$('mute').onclick = () => {
  muted = !(muted || autoMuted);
  autoMuted = false;
  applyMute();
};
$('progress').onclick = () => conversation?.sendUserMessage('Please use get_progress and tell me what OpenCode is doing.');
$('message-form').onsubmit = async event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!text || !conversation) return;
  try {
    await record(`typed:${crypto.randomUUID()}`, text);
    typedEchoes.push(text);
    conversation.sendUserMessage(text);
    line('user', text);
    $('message').value = '';
  } catch (e) { error(e); }
};
controls(false);
if (!key) error('Open the full URL printed by npm run voice:dev, including its # fragment.');
else void $('refresh').onclick();
