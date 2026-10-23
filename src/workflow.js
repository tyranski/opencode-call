import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Single-process journal. Persist before network writes; never silently reset corrupt state. */
export class Journal {
  constructor(path) {
    this.path = path;
    try { this.tasks = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.tasks = {}; }
  }
  save(task) {
    const next = { ...this.tasks, [task.id]: structuredClone(task) };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flush: true });
    renameSync(temporary, this.path);
    this.tasks = next;
    return structuredClone(task);
  }
  get(id) {
    if (!this.tasks[id]) throw new Error('Unknown task');
    return structuredClone(this.tasks[id]);
  }
}

const active = new Set(['dispatching', 'uncertain', 'submitted', 'running', 'waiting', 'cancelling']);

/** Structured authorization boundary, not a natural-language intent classifier. */
export class Workflow {
  constructor(client, journal) {
    this.client = client;
    this.journal = journal;
    this.target = `${client.url.origin}|${client.directory ?? ''}`;
  }

  task(id) {
    const task = this.journal.get(id);
    if (task.target !== this.target) throw new Error('Task belongs to a different server or project');
    return task;
  }

  propose(sessionID, text) {
    if (!sessionID || typeof text !== 'string' || !text.trim()) throw new Error('An agreed task and session are required');
    return this.journal.save({ id: randomUUID(), target: this.target, sessionID, text: text.trim(), state: 'proposed' });
  }

  async authorize(taskID, { confirmed = false } = {}) {
    if (confirmed !== true) throw new Error('Explicit authorization is required');
    const task = this.task(taskID);
    if (task.state !== 'proposed') throw new Error('This task has already been submitted or needs reconciliation');
    if (Object.values(this.journal.tasks).some(t => t.target === this.target && t.sessionID === task.sessionID && active.has(t.state))) {
      throw new Error('Another task in this session is active or unresolved');
    }
    // Reserve synchronously before awaiting, preventing concurrent local dispatch.
    task.state = 'dispatching';
    task.messageID = `msg_${Date.now().toString(16)}${randomBytes(12).toString('hex')}`;
    this.journal.save(task);
    try {
      const snapshot = await this.client.snapshot(task.sessionID);
      if (snapshot.status.type !== 'idle' || snapshot.permissions.length || snapshot.questions.length) {
        task.state = 'proposed';
        this.journal.save(task);
        throw new Error('Session is busy or waiting for input');
      }
    } catch (error) {
      task.state = 'proposed';
      this.journal.save(task);
      throw error;
    }
    try {
      await this.client.prompt(task.sessionID, {
        messageID: task.messageID, agent: 'build',
        parts: [{ type: 'text', text: `${task.text}\n\nImplement only this agreed task and run relevant checks. Do not commit, push, or open a pull request unless that action is explicitly included in the agreed task above. Report results and blockers when finished.` }],
      });
      task.state = 'submitted';
    } catch (error) {
      // Even a server error may follow acceptance. Never replay automatically.
      task.state = 'uncertain';
      this.journal.save(task);
      throw error;
    }
    return this.journal.save(task);
  }

  async reconcile(taskID) {
    const task = this.task(taskID);
    if (!active.has(task.state)) return task;
    const snapshot = await this.client.snapshot(task.sessionID);
    const accepted = snapshot.messages.some(m => m.info.id === task.messageID);
    const replies = snapshot.messages.filter(m => m.info.role === 'assistant' && m.info.parentID === task.messageID);
    const latest = replies.at(-1);
    if (latest?.info.error) {
      task.state = latest.info.error.name === 'MessageAbortedError' ? 'cancelled' : 'failed';
      task.error = latest.info.error;
    } else if (accepted && snapshot.status.type === 'idle' && latest?.info.time?.completed &&
               ['stop', 'end_turn'].includes(latest.info.finish)) {
      task.state = 'finished';
      task.report = latest.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    } else if (accepted) {
      task.state = task.state === 'cancelling' ? 'cancelling'
        : snapshot.permissions.length || snapshot.questions.length ? 'waiting'
        : snapshot.status.type === 'idle' ? 'submitted' : 'running';
    } else {
      task.state = 'uncertain';
    }
    task.observedAt = snapshot.observedAt;
    return this.journal.save(task);
  }

  async cancel(taskID) {
    const task = this.task(taskID);
    if (!active.has(task.state)) throw new Error('Task is not active');
    const snapshot = await this.client.snapshot(task.sessionID);
    const latestUser = snapshot.messages.filter(m => m.info.role === 'user').at(-1);
    if (latestUser?.info.id !== task.messageID) {
      throw new Error('Cannot confirm this task owns the active session; reconcile before cancelling');
    }
    task.state = 'cancelling';
    this.journal.save(task);
    await this.client.abort(task.sessionID);
    // Acknowledged abort is not proof of rollback or process termination.
    return task;
  }
}

/** Separate investigation session: default-deny, allowing only built-in file inspection. */
export async function investigate(client, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('An investigation question is required');
  const permission = [
    { permission: '*', pattern: '*', action: 'deny' },
    ...['read', 'glob', 'grep', 'list'].map(name => ({ permission: name, pattern: '*', action: 'allow' })),
  ];
  const session = await client.request('/session', {
    method: 'POST', body: { title: 'Voice investigation (read-only)', permission },
  });
  if (JSON.stringify(session.permission) !== JSON.stringify(permission)) {
    throw new Error('Server did not retain the required investigation permission policy');
  }
  await client.prompt(session.id, {
    agent: 'plan',
    parts: [{ type: 'text', text: `Investigate without modifying the project. Use only file inspection tools.\n\n${text}` }],
  });
  return session;
}
