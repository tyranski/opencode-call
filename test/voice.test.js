import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceTools } from '../src/voice-tools.js';
import { Workflow, Journal } from '../src/workflow.js';
import { createVoiceServer, conversationToken } from '../src/voice-server.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-voice-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = {
    observedAt: new Date().toISOString(), session: { id: 'ses_1', title: 'Login' },
    status: { type: 'idle' }, messages: [], permissions: [], questions: [],
  };
  const calls = [];
  const client = {
    url: new URL('http://localhost:4096'), directory: '/repo',
    snapshot: async sessionID => ({ ...structuredClone(state), session: { ...state.session, id: sessionID } }),
    sessions: async () => [state.session],
    prompt: async (sessionID, body) => { calls.push({ type: 'prompt', sessionID, body }); },
    abort: async sessionID => { calls.push({ type: 'abort', sessionID }); },
    replyPermission: async (...args) => { calls.push({ type: 'permission', args }); return true; },
    replyQuestion: async (...args) => { calls.push({ type: 'question', args }); return true; },
  };
  const workflow = new Workflow(client, new Journal(join(directory, 'tasks.json')));
  let now = 100000;
  const tools = new VoiceTools(client, workflow, { now: () => now });
  await tools.select('ses_1');
  return { client, workflow, state, calls, tools, advance: () => { now += 61000; } };
}

test('voice authorization requires a new transcript after the exact proposal', async t => {
  const { tools, calls } = await fixture(t);
  tools.recordTranscript({ id: 'before', text: 'start building' });
  const task = await tools.call('propose_task', { text: 'Fix login' });
  await assert.rejects(tools.call('start_build', { taskID: task.taskID }), /fresh/);
  for (const [i, text] of ['okay', "don't start building", 'say start building', 'start building after I return', 'gå ikke i gang med at bygge'].entries()) {
    tools.recordTranscript({ id: `negative-${i}`, text });
    await assert.rejects(tools.call('start_build', { taskID: task.taskID }), /fresh/);
  }
  assert.equal(calls.length, 0);
  tools.recordTranscript({ id: 'yes', text: 'Gå i gang med at bygge!' });
  await tools.call('start_build', { taskID: task.taskID });
  assert.equal(calls.length, 1);
  await assert.rejects(tools.call('start_build', { taskID: task.taskID }), /fresh/);
});

test('tool-provided approval, expired commands, transcript replay and superseded proposals cannot authorize', async t => {
  const { tools, calls, advance } = await fixture(t);
  const old = await tools.call('propose_task', { text: 'Old task' });
  const latest = await tools.call('propose_task', { text: 'New task' });
  tools.recordTranscript({ id: 'yes', text: 'start building' });
  await assert.rejects(tools.call('start_build', { taskID: latest.taskID, confirmed: true }), /Invalid/);
  await assert.rejects(tools.call('start_build', { taskID: old.taskID }), /latest/);
  advance();
  await assert.rejects(tools.call('start_build', { taskID: latest.taskID }), /fresh/);
  tools.recordTranscript({ id: 'yes', text: 'start building' });
  await assert.rejects(tools.call('start_build', { taskID: latest.taskID }), /fresh/);
  assert.equal(calls.length, 0);
});

test('progress and proposed follow-ups never submit prompts or cancel active builds', async t => {
  const { tools, calls, state } = await fixture(t);
  state.status = { type: 'busy' };
  state.messages = [{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', title: 'Run tests' } }] }];
  const result = await tools.call('get_progress');
  assert.equal(result.recentActions[0].title, 'Run tests');
  await tools.call('propose_task', { text: 'Also support Apple login later' });
  assert.equal(calls.length, 0);
});

test('permission approval must follow disclosure and consumes one instruction', async t => {
  const { tools, calls, state } = await fixture(t);
  state.permissions = [{ id: 'per_1', sessionID: 'ses_1', permission: 'bash' }];
  tools.recordTranscript({ id: 'early', text: 'approve once' });
  await assert.rejects(tools.call('reply_permission', { requestID: 'per_1', reply: 'once' }), /Read/);
  await tools.call('get_progress');
  await assert.rejects(tools.call('reply_permission', { requestID: 'per_1', reply: 'once' }), /fresh/);
  tools.recordTranscript({ id: 'after', text: 'godkend én gang' });
  await tools.call('reply_permission', { requestID: 'per_1', reply: 'once' });
  await assert.rejects(tools.call('reply_permission', { requestID: 'per_1', reply: 'once' }), /Read/);
  assert.deepEqual(calls, [{ type: 'permission', args: ['ses_1', 'per_1', 'once'] }]);
});

test('bare stop cannot cancel but explicit build cancellation can', async t => {
  const { tools, calls, state } = await fixture(t);
  const task = await tools.call('propose_task', { text: 'Fix login' });
  tools.recordTranscript({ id: 'go', text: 'start building' });
  const dispatched = await tools.call('start_build', { taskID: task.taskID });
  state.messages = [{ info: { role: 'user', id: dispatched.messageID }, parts: [] }];
  tools.recordTranscript({ id: 'stop', text: 'stop' });
  await assert.rejects(tools.call('cancel_build'), /fresh/);
  tools.recordTranscript({ id: 'cancel', text: 'stop med at bygge' });
  await tools.call('cancel_build');
  assert.equal(calls.at(-1).type, 'abort');
});

test('a question answer must be the actual subsequent transcript, not an agent-generated answer', async t => {
  const { tools, state, calls } = await fixture(t);
  state.questions = [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Which login provider?' }] }];
  await tools.call('get_progress');
  tools.recordTranscript({ id: 'answer', text: 'Apple' });
  await assert.rejects(tools.call('answer_question', { requestID: 'que_1', answer: 'Google' }), /exactly/);
  await tools.call('answer_question', { requestID: 'que_1', answer: 'Apple' });
  assert.deepEqual(calls, [{ type: 'question', args: ['ses_1', 'que_1', [['Apple']]] }]);
});

test('multiple pending permissions cannot be approved with an ambiguous approve-once command', async t => {
  const { tools, state, calls } = await fixture(t);
  state.permissions = [{ id: 'per_1' }, { id: 'per_2' }];
  await tools.call('get_progress');
  tools.recordTranscript({ id: 'approve', text: 'approve once' });
  await assert.rejects(tools.call('reply_permission', { requestID: 'per_1', reply: 'once' }), /Multiple/);
  assert.equal(calls.length, 0);
});

test('completion announcements require evidence, repeat until ack, and preserve last update', async t => {
  const { tools, state } = await fixture(t);
  assert.deepEqual((await tools.poll()).updates, []);
  state.messages = [{ info: { id: 'msg_1', role: 'assistant', finish: 'tool-calls', time: { completed: 1 } }, parts: [] }];
  assert.deepEqual((await tools.poll()).updates, []);
  state.messages.push({ info: { id: 'msg_2', role: 'assistant', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'Fixed login. Tests passed.' }] });
  const first = (await tools.poll()).updates;
  assert.equal(first.length, 1);
  assert.deepEqual((await tools.poll()).updates, first);
  tools.acknowledge(first[0].id);
  assert.deepEqual((await tools.poll()).updates, []);
  assert.equal((await tools.call('repeat_update')).report, 'Fixed login. Tests passed.');
});

test('ElevenLabs token exchange keeps the long-lived key on the server and validates the response', async () => {
  let request;
  const token = await conversationToken({ apiKey: 'private-test-key', agentID: 'agent_test', fetcher: async (url, options) => {
    request = { url, options };
    return Response.json({ token: 'short-lived-token' });
  } });
  assert.equal(token, 'short-lived-token');
  assert.equal(request.url.searchParams.get('agent_id'), 'agent_test');
  assert.equal(request.options.headers['xi-api-key'], 'private-test-key');
  await assert.rejects(conversationToken({ apiKey: 'x', agentID: 'y', fetcher: async () => new Response('secret provider response', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(conversationToken({}), /Set ELEVENLABS/);
});

test('bridge rejects unauthenticated/cross-origin calls and scopes tools to a live room', async t => {
  const { client, workflow, calls } = await fixture(t);
  const { server, key } = createVoiceServer({ client, workflow, key: 'bridge-test-key', getToken: async () => 'provider-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${key}`, Origin: 'https://other.example' } })).status, 403);
  const post = (path, body) => fetch(`${url}/api/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const room = await (await post('conversation', { sessionID: 'ses_1' })).json();
  assert.equal(room.token, 'provider-token');
  const task = await (await post('tool', { roomID: room.roomID, name: 'propose_task', args: { text: 'Fix login' } })).json();
  assert.equal((await post('tool', { roomID: room.roomID, name: 'start_build', args: { taskID: task.taskID } })).status, 400);
  assert.equal(calls.length, 0);
  await post('transcript', { roomID: room.roomID, transcript: { id: 'user1', text: 'start building' } });
  assert.equal((await post('tool', { roomID: room.roomID, name: 'start_build', args: { taskID: task.taskID } })).status, 200);
  assert.equal(calls.length, 1);
  await post('end', { roomID: room.roomID });
  assert.equal((await post('tool', { roomID: room.roomID, name: 'get_progress' })).status, 404);
});
