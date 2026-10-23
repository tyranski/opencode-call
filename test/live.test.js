import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCode } from '../src/opencode.js';

// Opt-in: starts a real local server and creates/deletes one empty session.
// No provider requests, prompts, tools, or modifications to user projects.
test('installed OpenCode supports the integration contract', { skip: !process.env.OPENCODE_LIVE_TEST, timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-call-live-'));
  const server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      const closed = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      const kill = setTimeout(() => server.kill('SIGKILL'), 3000);
      await closed;
      clearTimeout(kill);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${errors}`)); });
  });
  const client = new OpenCode({ url, directory, password: process.env.OPENCODE_SERVER_PASSWORD, username: process.env.OPENCODE_SERVER_USERNAME, timeout: 20000 });
  const health = await client.health();
  assert.equal(health.healthy, true);
  t.diagnostic(`OpenCode ${health.version}`);
  const schema = await client.schema();
  for (const path of ['/session/{sessionID}/prompt_async', '/session/{sessionID}/abort', '/permission/{requestID}/reply', '/question/{requestID}/reply']) {
    assert.ok(schema.paths[path]?.post, path);
  }
  const permission = [{ permission: '*', pattern: '*', action: 'deny' }];
  const session = await client.request('/session', { method: 'POST', body: { title: 'OpenCode Call contract smoke test', permission } });
  try {
    assert.deepEqual(session.permission, permission);
    assert.ok((await client.sessions()).some(s => s.id === session.id));
    const snapshot = await client.snapshot(session.id);
    assert.equal(snapshot.status.type, 'idle');
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.permissions, []);
    assert.deepEqual(snapshot.questions, []);
  } finally {
    await client.request(`/session/${session.id}`, { method: 'DELETE' });
  }
});
