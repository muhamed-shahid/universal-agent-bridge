#!/usr/bin/env node
// Mock coding CLI for tests. Behaviour is selected by MOCK_CLI_SCENARIO. Never contacts any
// provider and never needs credentials. The "secrets" below are fake values used to prove
// that UAB never copies them into its results.
import { spawn } from 'node:child_process';

const scenario = process.env.MOCK_CLI_SCENARIO ?? 'ok';
const args = process.argv.slice(2);
const cmd = args.join(' ');
const out = (s) => process.stdout.write(s);

function hang() {
  setInterval(() => {}, 1000);
}

if (cmd === 'echo-args') {
  out(JSON.stringify(args));
} else if (args[0] === 'echo-args') {
  out(JSON.stringify(args.slice(1)));
} else if (cmd === 'echo-env') {
  out(JSON.stringify(Object.keys(process.env).sort()));
} else if (cmd === 'echo-stdin') {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => out(JSON.stringify({ stdin: data })));
} else if (cmd === 'exit-code') {
  process.stderr.write('failure details\n');
  process.exit(7);
} else if (cmd === 'huge') {
  out('x'.repeat(1024 * 1024));
} else if (cmd === 'hang') {
  hang();
} else if (cmd === 'tree') {
  // Starts a grandchild that never exits, prints its pid, then hangs too.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  out(`${child.pid}\n`);
  hang();
} else if (cmd === '--version') {
  if (scenario === 'version-garbage') out('no version here');
  else if (scenario === 'version-hang') hang();
  else out('mock-cli 1.2.3-beta.1 (build abc)\n');
} else if (cmd === 'auth status --json') {
  switch (scenario) {
    case 'ok':
    case 'version-garbage':
    case 'version-hang':
      out(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'oauth',
          email: 'someone@example.com',
          apiKey: 'sk-fake-secret-value-0000',
          orgId: 'org-123',
        }),
      );
      break;
    case 'hostile-label':
      out(JSON.stringify({ loggedIn: true, authMethod: 'token=sk-fake-secret-value-0000' }));
      break;
    case 'logged-out':
      out(JSON.stringify({ loggedIn: false }));
      process.exit(1);
      break;
    case 'garbage':
      out('<<< not json >>> sk-fake-secret-value-0000');
      break;
    case 'crash':
      process.stderr.write('panic: sk-fake-secret-value-0000\n');
      process.exit(101);
      break;
    case 'auth-hang':
      hang();
      break;
    default:
      out('{}');
  }
} else {
  process.stderr.write(`mock-cli: unknown command: ${cmd}\n`);
  process.exit(2);
}
