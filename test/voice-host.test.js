import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createVoiceServer } from '../src/voice-server.js';

async function bridge(t, options = {}) {
  const { server } = createVoiceServer({ key: 'test-key', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (host, origin, path = '/') => new Promise((resolve, reject) => {
    // Node fetch replaces Host; use HTTP to reproduce proxy-preserved headers.
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path,
      headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('voice page works through a remapped localhost port', async t => {
  const get = await bridge(t);
  for (const host of ['localhost:3211', '127.0.0.1:43210', '[::1]:3211']) {
    const result = await get(host, `http://${host}`);
    assert.equal(result.status, 200, result.body);
    assert.match(result.body, /OpenCode Call/);
  }
  assert.equal((await get('localhost:3211', undefined, '/api/config')).status, 401);
});

test('only explicitly configured external origin is accepted', async t => {
  const get = await bridge(t, { publicOrigin: 'https://voice.example.test' });
  assert.equal((await get('voice.example.test', 'https://voice.example.test')).status, 200);
  assert.equal((await get('other.example.test')).status, 403);
  assert.equal((await get('localhost:3211', 'https://other.example.test')).status, 403);
  assert.equal((await get('voice.example.test', 'http://voice.example.test')).status, 403);
});
