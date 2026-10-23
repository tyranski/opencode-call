import { OpenCode, progress } from './opencode.js';

const [command, sessionID] = process.argv.slice(2);
const client = new OpenCode({
  url: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096',
  directory: process.env.OPENCODE_DIRECTORY,
  username: process.env.OPENCODE_SERVER_USERNAME,
  password: process.env.OPENCODE_SERVER_PASSWORD,
});
const print = value => console.log(JSON.stringify(value, null, 2));

try {
  switch (command) {
    case 'inspect': {
      const [health, schema] = await Promise.all([client.health(), client.schema()]);
      const required = {
        '/session': ['get', 'post'], '/session/status': ['get'],
        '/session/{sessionID}/message': ['get'], '/session/{sessionID}/prompt_async': ['post'],
        '/session/{sessionID}/abort': ['post'], '/event': ['get'],
        '/permission': ['get'], '/permission/{requestID}/reply': ['post'],
        '/question': ['get'], '/question/{requestID}/reply': ['post'],
      };
      const missing = Object.entries(required).flatMap(([path, methods]) =>
        methods.filter(method => !schema.paths?.[path]?.[method]).map(method => `${method.toUpperCase()} ${path}`));
      print({ health, missing, compatibleEndpoints: missing.length === 0 });
      if (missing.length) process.exitCode = 1;
      break;
    }
    case 'sessions': print(await client.sessions()); break;
    case 'progress':
      if (!sessionID) throw new Error('Usage: npm run opencode:progress -- <session-id>');
      print(progress(await client.snapshot(sessionID)));
      break;
    case 'watch': {
      if (!sessionID) throw new Error('Usage: npm run opencode:watch -- <session-id>');
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      for await (const update of client.watch(sessionID, { signal: controller.signal })) {
        print(update.type === 'snapshot' ? { type: 'progress', ...progress(update.snapshot) } : update);
      }
      break;
    }
    default: throw new Error('Commands: inspect, sessions, progress <session-id>, watch <session-id>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
