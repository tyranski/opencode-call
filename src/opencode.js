import { setTimeout as delay } from 'node:timers/promises';

export class HttpError extends Error {
  constructor(method, path, status) {
    super(`OpenCode ${method} ${path} returned HTTP ${status}`);
    this.status = status;
  }
}

const id = encodeURIComponent;

/** Small transport boundary; no model calls are needed for progress checks. */
export class OpenCode {
  constructor({ url, directory, username = 'opencode', password, timeout = 10000 }) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) {
      throw new Error('Use an HTTP(S) URL without embedded credentials');
    }
    this.directory = directory;
    this.timeout = timeout;
    this.headers = password
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
      : {};
  }

  async request(path, { method = 'GET', body, signal, stream = false, query = {} } = {}) {
    const url = new URL(path, this.url);
    if (this.directory) url.searchParams.set('directory', this.directory);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const timeout = stream ? undefined : AbortSignal.timeout(this.timeout);
    const signals = [signal, timeout].filter(Boolean);
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: signals.length ? AbortSignal.any(signals) : undefined,
      headers: {
        ...this.headers,
        Accept: stream ? 'text/event-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(method, path, response.status);
    }
    if (stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new Error('OpenCode did not return an event stream');
      }
      return response;
    }
    return response.status === 204 ? undefined : response.json();
  }

  health() { return this.request('/global/health'); }
  schema() { return this.request('/doc'); }
  projects() { return this.request('/project'); }
  sessions() { return this.request('/session'); }
  agents() { return this.request('/agent'); }
  messages(sessionID) { return this.request(`/session/${id(sessionID)}/message`); }
  prompt(sessionID, body) {
    return this.request(`/session/${id(sessionID)}/prompt_async`, { method: 'POST', body });
  }
  abort(sessionID) {
    return this.request(`/session/${id(sessionID)}/abort`, { method: 'POST' });
  }

  async snapshot(sessionID) {
    const [session, statuses, messages, permissions, questions] = await Promise.all([
      this.request(`/session/${id(sessionID)}`),
      this.request('/session/status'),
      this.messages(sessionID),
      this.request('/permission'),
      this.request('/question'),
    ]);
    return {
      observedAt: new Date().toISOString(), session,
      status: statuses[sessionID] ?? { type: 'idle' }, messages,
      permissions: permissions.filter(p => p.sessionID === sessionID),
      questions: questions.filter(q => q.sessionID === sessionID),
    };
  }

  async replyPermission(sessionID, requestID, reply) {
    if (!['once', 'reject'].includes(reply)) throw new Error('Only one-time approval or rejection is supported');
    const pending = await this.request('/permission');
    if (!pending.some(p => p.id === requestID && p.sessionID === sessionID)) {
      throw new Error('Permission is no longer pending in this session');
    }
    return this.request(`/permission/${id(requestID)}/reply`, { method: 'POST', body: { reply } });
  }

  async replyQuestion(sessionID, requestID, answers) {
    const pending = await this.request('/question');
    const question = pending.find(q => q.id === requestID && q.sessionID === sessionID);
    if (!question) throw new Error('Question is no longer pending in this session');
    if (!Array.isArray(answers) || answers.length !== question.questions.length ||
        answers.some(a => !Array.isArray(a) || !a.length || a.some(v => typeof v !== 'string'))) {
      throw new Error('Supply one array of answer strings per question');
    }
    return this.request(`/question/${id(requestID)}/reply`, { method: 'POST', body: { answers } });
  }

  /** Reconcile on every connection; events are hints, not a durable completion log. */
  async *watch(sessionID, { signal, reconnectDelay = 1000 } = {}) {
    while (!signal?.aborted) {
      const connection = new AbortController();
      const streamSignal = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
      try {
        // Open the stream first so events during snapshot retrieval are buffered.
        const response = await this.request('/event', { stream: true, signal: streamSignal });
        yield { type: 'snapshot', snapshot: await this.snapshot(sessionID) };
        for await (const event of parseEvents(response.body)) {
          if (event.properties?.sessionID === sessionID || event.properties?.info?.sessionID === sessionID ||
              event.properties?.part?.sessionID === sessionID || event.type === 'server.connected') {
            yield { type: 'event', event };
            yield { type: 'snapshot', snapshot: await this.snapshot(sessionID) };
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) throw error;
        yield { type: 'disconnected', message: error.message };
      } finally {
        connection.abort();
      }
      try { await delay(reconnectDelay, undefined, { signal }); }
      catch (error) { if (signal?.aborted) return; throw error; }
    }
  }
}

/** Handles UTF-8/chunk boundaries, CRLF, multiline data, and SSE comments. */
export async function* parseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield JSON.parse(data);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Event frame exceeds 4 MiB');
  }
}

export function progress(snapshot) {
  const actions = snapshot.messages.flatMap(message => message.parts
    .filter(part => part.type === 'tool')
    .map(part => ({ tool: part.tool, status: part.state.status, title: part.state.title ?? part.tool })));
  return {
    sessionID: snapshot.session.id,
    title: snapshot.session.title,
    observedAt: snapshot.observedAt,
    status: snapshot.status.type,
    needsInput: snapshot.permissions.length > 0 || snapshot.questions.length > 0,
    recentActions: actions.slice(-5),
    // Idle is deliberately not described as success.
    note: 'Observed activity, not a claim that implementation or checks succeeded.',
  };
}
