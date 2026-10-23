import { progress } from './opencode.js';
import { investigate } from './workflow.js';
import { voiceTools } from './agent-config.js';

const normalize = text => text.normalize('NFKC').toLocaleLowerCase().trim().replace(/[.!?]+$/, '').trim();
const commands = {
  build: new Set(['start building', 'start the build', 'implement that', 'gå i gang med at bygge', 'gå i gang med det', 'begynd at bygge']),
  cancel: new Set(['stop building', 'cancel the build', 'stop med at bygge', 'annuller byggeriet']),
  once: new Set(['approve once', 'godkend én gang', 'godkend en gang']),
  reject: new Set(['reject permission', 'afvis tilladelsen']),
};

const terminal = message => message.info.role === 'assistant' &&
  (message.info.error || (message.info.time?.completed && ['stop', 'end_turn'].includes(message.info.finish)));
const report = message => message?.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';

/** One browser conversation owns this instance. Tools cannot supply user authorization. */
export class VoiceTools {
  constructor(client, workflow, { now = Date.now } = {}) {
    this.client = client;
    this.workflow = workflow;
    this.now = now;
    this.sequence = 0;
    this.seenTranscripts = new Set();
    this.seenUpdates = new Set();
    this.investigations = new Set();
    this.exposedPermissions = new Set();
    this.queue = Promise.resolve();
  }

  exclusive(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async select(sessionID) {
    const snapshot = await this.client.snapshot(sessionID);
    this.sessionID = sessionID;
    this.proposal = undefined;
    this.utterance = undefined;
    this.exposedPermissions.clear();
    this.buildTaskID = Object.values(this.workflow.journal.tasks)
      .filter(t => t.target === this.workflow.target && t.sessionID === sessionID && t.state !== 'proposed').at(-1)?.id;
    for (const message of snapshot.messages.filter(terminal)) this.seenUpdates.add(`message:${message.info.id}`);
    this.lastUpdate = { title: snapshot.session.title, report: report(snapshot.messages.filter(terminal).at(-1)) };
    return progress(snapshot);
  }

  recordTranscript({ id, text }) {
    if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim() || text.length > 10000) {
      throw new Error('A user transcript ID and text are required');
    }
    if (this.seenTranscripts.has(id)) return;
    this.seenTranscripts.add(id);
    this.utterance = { text, sequence: ++this.sequence, at: this.now(), consumed: false };
  }

  consume(kind, after = -1) {
    const value = this.utterance;
    if (!value || value.consumed || value.sequence <= after || this.now() - value.at > 60000 ||
        !commands[kind]?.has(normalize(value.text))) {
      throw new Error(`A fresh explicit ${kind} instruction from the user is required; ask for clarification`);
    }
    value.consumed = true;
  }

  async call(name, args = {}) {
    const definition = voiceTools.find(tool => tool.name === name);
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool or invalid arguments');
    const properties = definition.parameters.properties;
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) ||
        Object.keys(properties).some(key => typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 20000 ||
          (properties[key].enum && !properties[key].enum.includes(args[key])))) {
      throw new Error('Invalid tool arguments');
    }
    if (!this.sessionID) throw new Error('Select an OpenCode session first');
    switch (name) {
      case 'get_progress': {
        const snapshot = await this.client.snapshot(this.sessionID);
        this.exposedPermissions = new Set(snapshot.permissions.map(p => p.id));
        this.permissionSequence = this.sequence;
        this.exposedQuestions = snapshot.questions;
        this.questionSequence = this.sequence;
        return { ...progress(snapshot), permissions: snapshot.permissions, questions: snapshot.questions,
          latestReport: report(snapshot.messages.filter(terminal).at(-1)).slice(0, 16000) };
      }
      case 'propose_task': {
        const task = this.workflow.propose(this.sessionID, args.text);
        this.proposal = { id: task.id, sequence: this.sequence };
        return { taskID: task.id, text: task.text, instruction: 'Read back scope and wait for a NEW explicit build instruction.' };
      }
      case 'start_build': {
        if (!this.proposal || this.proposal.id !== args.taskID) throw new Error('Only the latest proposal can be authorized');
        this.consume('build', this.proposal.sequence);
        // Retain identity even if delivery is uncertain.
        this.buildTaskID = args.taskID;
        return this.workflow.authorize(args.taskID, { confirmed: true });
      }
      case 'cancel_build':
        if (!this.buildTaskID) throw new Error('No build started here is available to cancel');
        this.consume('cancel');
        return this.workflow.cancel(this.buildTaskID);
      case 'investigate': {
        const session = await investigate(this.client, args.question);
        this.investigations.add(session.id);
        return { sessionID: session.id, status: 'submitted' };
      }
      case 'investigation_result': {
        if (!this.investigations.has(args.sessionID)) throw new Error('Unknown investigation');
        const snapshot = await this.client.snapshot(args.sessionID);
        return { ...progress(snapshot), report: report(snapshot.messages.filter(terminal).at(-1)).slice(0, 16000) };
      }
      case 'reply_permission':
        if (!this.exposedPermissions.has(args.requestID)) throw new Error('Read the pending permission to the user first');
        if (this.exposedPermissions.size !== 1) throw new Error('Multiple permissions are pending; resolve them in OpenCode to avoid ambiguous approval');
        this.consume(args.reply, this.permissionSequence);
        this.exposedPermissions.delete(args.requestID);
        return this.client.replyPermission(this.sessionID, args.requestID, args.reply);
      case 'answer_question': {
        if (this.exposedQuestions?.length !== 1 || this.exposedQuestions[0].id !== args.requestID ||
            this.exposedQuestions[0].questions.length !== 1) throw new Error('Read the single pending question first; multi-question requests need OpenCode');
        const value = this.utterance;
        if (!value || value.consumed || value.sequence <= this.questionSequence || this.now() - value.at > 60000 ||
            args.answer !== value.text) throw new Error('Answer must exactly match the new user transcript');
        value.consumed = true;
        return this.client.replyQuestion(this.sessionID, args.requestID, [[args.answer]]);
      }
      case 'repeat_update': return this.lastUpdate ?? { report: 'No update has been received yet.' };
    }
  }

  async poll() {
    if (!this.sessionID) return { updates: [] };
    if (this.buildTaskID) await this.workflow.reconcile(this.buildTaskID);
    const snapshot = await this.client.snapshot(this.sessionID);
    const updates = [];
    // Only terminal assistant turns are announcements; idle alone is insufficient.
    if (snapshot.status.type === 'idle') {
      const latest = snapshot.messages.filter(terminal).at(-1);
      if (latest && !this.seenUpdates.has(`message:${latest.info.id}`)) {
        updates.push({ id: `message:${latest.info.id}`, kind: latest.info.error ? 'error' : 'completion',
          title: snapshot.session.title, report: report(latest).slice(0, 16000), error: latest.info.error });
      }
    }
    for (const [kind, pending] of [['permission', snapshot.permissions], ['question', snapshot.questions]]) {
      for (const request of pending) {
        const id = `${kind}:${request.id}`;
        if (!this.seenUpdates.has(id)) updates.push({ id, kind, title: snapshot.session.title, request });
      }
    }
    // Acknowledgement is separate so a failed HTTP response does not lose the update.
    this.pendingUpdates = new Map(updates.map(update => [update.id, update]));
    return { progress: progress(snapshot), updates };
  }

  acknowledge(id) {
    const update = this.pendingUpdates?.get(id);
    if (!update) throw new Error('Unknown update');
    this.seenUpdates.add(id);
    this.lastUpdate = update;
  }
}
