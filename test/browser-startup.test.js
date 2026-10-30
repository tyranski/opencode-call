import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the browser entry point without opening a microphone or importing WebRTC.
// These DOM doubles cover only startup/selection; audio remains a device test.
const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace("import { Conversation } from '@elevenlabs/client';", '');

function element() {
  return {
    children: [], disabled: false, textContent: '', value: '',
    replaceChildren() { this.children = []; this.value = ''; },
    append(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; },
  };
}

async function page({ hash = '#local-key', storage = new Map(), respond, microphone } = {}) {
  const elements = new Map();
  const requests = [];
  const location = { hash, pathname: '/' };
  const context = {
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element },
    location,
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: microphone ?? (async () => ({ getTracks: () => [] })) } },
    history: { replaceState() { location.hash = ''; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return respond ? respond(path, options) : { ok: true, json: async () => [{ id: 'ses_1', title: 'Login' }] };
    },
    setTimeout, clearTimeout, console,
  };
  runInNewContext(source, context);
  // Let fetch/json and the startup handler settle.
  await new Promise(resolve => setImmediate(resolve));
  return { elements, requests, storage };
}

test('opening the printed URL automatically loads sessions and enables Start voice', async () => {
  const { elements, requests } = await page();
  assert.equal(requests[0]?.path, '/api/sessions');
  assert.equal(elements.get('session').value, 'ses_1');
  assert.equal(elements.get('start').disabled, false);
  assert.equal(elements.get('end').disabled, true);
});

test('refreshing after fragment removal retains tab authentication', async () => {
  const first = await page();
  const refreshed = await page({ hash: '', storage: first.storage });
  assert.equal(refreshed.requests[0]?.options.headers.Authorization, 'Bearer local-key');
  assert.equal(refreshed.elements.get('session').value, 'ses_1');
});

test('failed session loading leaves voice disabled and shows the server error', async () => {
  const { elements } = await page({ respond: async () => ({ ok: false, json: async () => ({ error: 'OpenCode is unavailable' }) }) });
  assert.equal(elements.get('start').disabled, true);
  assert.match(elements.get('error').textContent, /OpenCode is unavailable/);
  assert.equal(elements.get('refresh').disabled, false);
});

test('empty session list explains how to proceed instead of enabling voice', async () => {
  const { elements } = await page({ respond: async () => ({ ok: true, json: async () => [] }) });
  assert.equal(elements.get('start').disabled, true);
  assert.match(elements.get('error').textContent, /Create a session in OpenCode/);
});

test('a newly printed URL replaces the previous server key', async () => {
  const first = await page();
  const restarted = await page({ hash: '#new-key', storage: first.storage });
  assert.equal(restarted.requests[0]?.options.headers.Authorization, 'Bearer new-key');
});

test('microphone denial gives recovery instructions before any provider token request', async () => {
  const { elements, requests } = await page({ microphone: async () => {
    const error = new Error('Permission denied');
    error.name = 'NotAllowedError';
    throw error;
  } });
  // Also supports the original manual-loading flow when reproducing the bug.
  await elements.get('refresh').onclick();
  await elements.get('start').onclick();
  assert.match(elements.get('error').textContent, /microphone.*blocked/i);
  assert.match(elements.get('error').textContent, /Allow/);
  assert.equal(requests.some(r => r.path === '/api/conversation'), false);
  assert.equal(elements.get('start').disabled, false);
});
