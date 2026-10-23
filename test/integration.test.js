import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCode, parseEvents, progress } from '../src/opencode.js';
import { Journal, Workflow, investigate } from '../src/workflow.js';

async function fixture(t) {
  const state = { requests: [], statuses: {}, messages: [], permissions: [], questions: [], failPrompt: false };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, path: url.pathname, directory: url.searchParams.get('directory'), body, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (req.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
      if (state.failPrompt) { res.statusCode = 503; return send({ error: 'unknown outcome' }); }
      res.statusCode = 204; return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      return send({ id: 'ses_investigate', permission: state.dropPolicy ? [] : body.permission });
    }
    if (req.method === 'POST') return send(true);
    switch (url.pathname) {
      case '/global/health': return send({ healthy: true, version: 'fixture' });
      case '/session': return send([{ id: 'ses_1', title: 'Login' }]);
      case '/session/ses_1': return send({ id: 'ses_1', title: 'Login' });
      case '/session/status': return send(state.statuses);
      case '/session/ses_1/message': return send(state.messages);
      case '/permission': return send(state.permissions);
      case '/question': return send(state.questions);
      case '/event': {
        state.connections = (state.connections ?? 0) + 1;
        res.setHeader('Content-Type', 'text/event-stream');
        return res.end('data: {"type":"server.connected","properties":{}}\n\n');
      }
      default: res.statusCode = 404; send({ error: 'not found' });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'opencode-call-test-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const client = new OpenCode({ url: `http://127.0.0.1:${server.address().port}`, directory: '/repo with spaces', password: 'test-only', timeout: 1000 });
  const path = join(directory, 'journal.json');
  return { client, state, path, workflow: new Workflow(client, new Journal(path)) };
}

test('discovery and progress use only GET, preserve project context and report actual tool status', async t => {
  const { client, state } = await fixture(t);
  state.statuses.ses_1 = { type: 'busy' };
  state.messages = [{ info: { id: 'msg_a' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', title: 'Run login tests' } }] }];
  state.permissions = [{ id: 'p_other', sessionID: 'ses_other' }];
  assert.equal((await client.sessions())[0].id, 'ses_1');
  const report = progress(await client.snapshot('ses_1'));
  assert.equal(report.status, 'busy');
  assert.equal(report.needsInput, false);
  assert.deepEqual(report.recentActions, [{ tool: 'bash', status: 'running', title: 'Run login tests' }]);
  assert.ok(state.requests.every(r => r.method === 'GET' && r.directory === '/repo with spaces'));
  assert.ok(state.requests.every(r => r.auth === `Basic ${Buffer.from('opencode:test-only').toString('base64')}`));
});

test('a proposal requires confirmation and can dispatch only once, including concurrent calls', async t => {
  const { workflow, state } = await fixture(t);
  const task = workflow.propose('ses_1', 'Fix login');
  await assert.rejects(workflow.authorize(task.id), /Explicit/);
  assert.equal(state.requests.length, 0);
  const results = await Promise.allSettled([
    workflow.authorize(task.id, { confirmed: true }), workflow.authorize(task.id, { confirmed: true }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.requests.filter(r => r.path.endsWith('/prompt_async')).length, 1);
  assert.equal(workflow.journal.get(task.id).state, 'submitted');
});

test('a busy desktop session is not interrupted by a new build', async t => {
  const { workflow, state } = await fixture(t);
  state.statuses.ses_1 = { type: 'busy' };
  const task = workflow.propose('ses_1', 'Fix login');
  await assert.rejects(workflow.authorize(task.id, { confirmed: true }), /busy/);
  assert.equal(state.requests.filter(r => r.method === 'POST').length, 0);
});

test('uncertain dispatch survives restart, is not replayed, and reconciles by message identity', async t => {
  const { workflow, state, client, path } = await fixture(t);
  state.failPrompt = true;
  const task = workflow.propose('ses_1', 'Fix login');
  await assert.rejects(workflow.authorize(task.id, { confirmed: true }), /503/);
  const restarted = new Workflow(client, new Journal(path));
  await assert.rejects(restarted.authorize(task.id, { confirmed: true }), /already/);
  assert.equal((await restarted.reconcile(task.id)).state, 'uncertain');
  const { messageID } = restarted.journal.get(task.id);
  state.messages = [
    { info: { id: messageID, role: 'user' }, parts: [] },
    { info: { id: 'msg_old', role: 'assistant', parentID: 'unrelated', finish: 'stop', time: { completed: 1 } }, parts: [] },
  ];
  assert.equal((await restarted.reconcile(task.id)).state, 'submitted');
  state.messages.push({ info: { id: 'msg_done', role: 'assistant', parentID: messageID, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'Updated login; tests passed.' }] });
  const final = await restarted.reconcile(task.id);
  assert.equal(final.state, 'finished');
  assert.equal(final.report, 'Updated login; tests passed.');
  assert.equal(state.requests.filter(r => r.path.endsWith('/prompt_async')).length, 1);
});

test('idle and tool-call completion do not falsely finish an authorized task', async t => {
  const { workflow, state } = await fixture(t);
  const task = workflow.propose('ses_1', 'Fix login');
  const dispatched = await workflow.authorize(task.id, { confirmed: true });
  state.messages = [
    { info: { id: dispatched.messageID, role: 'user' }, parts: [] },
    { info: { role: 'assistant', parentID: dispatched.messageID, finish: 'tool-calls', time: { completed: 1 } }, parts: [] },
  ];
  assert.equal((await workflow.reconcile(task.id)).state, 'submitted');
  state.permissions = [{ id: 'p1', sessionID: 'ses_1' }];
  assert.equal((await workflow.reconcile(task.id)).state, 'waiting');
  await workflow.cancel(task.id);
  assert.equal(workflow.journal.get(task.id).state, 'cancelling');
  state.messages[1].info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
  assert.equal((await workflow.reconcile(task.id)).state, 'cancelled');
});

test('permission responses are one-time and scoped to the correct session', async t => {
  const { client, state } = await fixture(t);
  state.permissions = [{ id: 'p1', sessionID: 'ses_1' }];
  await assert.rejects(client.replyPermission('ses_1', 'p1', 'always'), /one-time/);
  await assert.rejects(client.replyPermission('ses_other', 'p1', 'once'), /no longer/);
  await client.replyPermission('ses_1', 'p1', 'once');
  const posts = state.requests.filter(r => r.method === 'POST');
  assert.deepEqual(posts.map(p => p.body), [{ reply: 'once' }]);
});

test('questions preserve multi-question answer shape and session ownership', async t => {
  const { client, state } = await fixture(t);
  state.questions = [{ id: 'q1', sessionID: 'ses_1', questions: [{ question: 'Which provider?' }] }];
  await assert.rejects(client.replyQuestion('ses_other', 'q1', [['Apple']]), /no longer/);
  await assert.rejects(client.replyQuestion('ses_1', 'q1', ['Apple']), /array/);
  await client.replyQuestion('ses_1', 'q1', [['Apple']]);
  assert.deepEqual(state.requests.at(-1).body, { answers: [['Apple']] });
});

test('investigation uses a separate default-deny session and refuses a dropped policy', async t => {
  const { client, state } = await fixture(t);
  await investigate(client, 'How does login work?');
  const created = state.requests.find(r => r.method === 'POST' && r.path === '/session');
  assert.deepEqual(created.body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.deepEqual(created.body.permission.slice(1).map(p => p.permission), ['read', 'glob', 'grep', 'list']);
  assert.equal(state.requests.at(-1).path, '/session/ses_investigate/prompt_async');
  state.dropPolicy = true;
  const before = state.requests.filter(r => r.path.endsWith('/prompt_async')).length;
  await assert.rejects(investigate(client, 'Try again'), /retain/);
  assert.equal(state.requests.filter(r => r.path.endsWith('/prompt_async')).length, before);
});

test('SSE parsing handles split Unicode, CRLF, comments and multiline JSON', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"test",\r\ndata: "text":"gå i gang"}\r\n\r\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events = [];
  for await (const event of parseEvents(chunks())) events.push(event);
  assert.deepEqual(events, [{ type: 'test', text: 'gå i gang' }]);
});

test('reconnecting event observation refreshes snapshots and never submits work', async t => {
  const { client, state } = await fixture(t);
  const abort = new AbortController();
  const snapshots = [];
  for await (const update of client.watch('ses_1', { signal: abort.signal, reconnectDelay: 1 })) {
    if (update.type === 'snapshot') snapshots.push(update.snapshot);
    if (state.connections >= 2) { abort.abort(); break; }
  }
  assert.ok(snapshots.length >= 2);
  assert.equal(state.requests.filter(r => r.method === 'POST').length, 0);
});
