import { Conversation } from '@elevenlabs/client';

const $ = id => document.getElementById(id);
const key = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let conversation, roomID, timer, muted = false, autoMuted = false, stopping = false;
let generation = 0;
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
  $('start').disabled = active;
  $('session').disabled = active;
  $('refresh').disabled = active;
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
  try {
    const sessions = await api('sessions');
    $('session').replaceChildren();
    for (const session of sessions) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.title} (${session.id})`;
      $('session').append(option);
    }
    if (!sessions.length) throw new Error('No sessions found. Create a session in OpenCode first.');
    $('error').textContent = '';
  } catch (e) { error(e); }
};

$('start').onclick = async () => {
  if (!$('session').value) return error('Load and select a session first.');
  $('start').disabled = true;
  $('error').textContent = '';
  transcriptQueue = Promise.resolve();
  typedEchoes.length = 0;
  announced.clear();
  const current = ++generation;
  try {
    // Ask permission before allocating a provider conversation; release this probe stream.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
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
      onError: error,
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
  } catch (e) { error(e); await finish(); }
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
if (!key) error('Open the full URL printed by npm run voice:dev, including its # fragment.');
