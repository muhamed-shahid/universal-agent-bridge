# Development

## Requirements

- Node.js 22.13 or later (`node:sqlite` is built in from 22.13; no native modules are compiled)
- npm
- Git

## Setup

```bash
git clone <repository-url>
cd universal-agent-bridge
npm install
npm run check
```

`npm run check` runs type-checking, ESLint, the Prettier check, all tests and the build. CI runs
the same steps on Windows, macOS and Linux with Node 22, 24 and 26.

## Running the CLI from a checkout

```bash
npm run build
node dist/cli.js --help
```

To keep development data away from your real UAB data, point `UAB_HOME` at a scratch directory
(absolute path):

```bash
# macOS / Linux
export UAB_HOME="$PWD/.uab"
# Windows PowerShell
$env:UAB_HOME = "$PWD\.uab"
```

`.uab/` is git-ignored.

## Tests

| Folder              | What belongs there                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ |
| `tests/unit`        | One module at a time; in-memory database where possible                              |
| `tests/security`    | Attack-style tests: path traversal, symlink escapes, cross-session access            |
| `tests/integration` | Several modules together against a real database file, including the CLI             |
| `tests/helpers`     | Sandboxes (temporary home, data and project directories), service wiring, fake clock |

Rules:

- Tests never read the developer's real home, data directory, credentials or coding CLIs.
  Use `createSandbox()` / `createServices()` from `tests/helpers`.
- Symlink tests use directory junctions on Windows, which need no admin rights. File-symlink
  tests skip themselves where the OS forbids them, and run on Linux and macOS CI.
- Compare paths with their canonical form (`realpathSync.native`). On Windows, the temp
  directory can be reported as an 8.3 short path.

## Database migrations

Migrations live in `src/database/migrations.ts`.

- Add a new entry with the next version number. **Never edit a released migration**: applied
  migrations are checksummed and UAB refuses to start if one changed.
- Use `STRICT` tables and constant SQL only.
- Do not store provider credentials, raw session tokens or unredacted agent output.
- Add a test in `tests/unit/database/migrate.test.ts` if the migration transforms data.

UAB backs up an existing database before applying new migrations (`uab.db.v<N>-<time>.bak` in
the data directory). `uab db backup <absolute-file>` writes a manual copy.

## Adding a coding agent

1. Add an `AgentDefinition` in `src/agents/adapters/` (see `builtin.ts` for examples) and
   append it to `BUILTIN_AGENTS`.
2. Probes must be read-only status commands. Their parsers must return only a state, a short
   label and UAB-written text: never raw output, emails, account ids, URLs or keys. Unreadable
   output must give `unknown`, never `authenticated`.
3. List every flag that weakens the CLI's own permission checks in `forbiddenArgs`, and add
   cases to `tests/security/agent-args.test.ts`.
4. Add parser tests with real (anonymised) output to `tests/unit/agents/`.
5. Document it in `docs/supported-agents.md`, including the version you verified against.

The `execution` part has three pure functions: `buildInvocation` (arguments and stdin for a
read-only or write task, optionally continuing a native session), `parseStdoutLine` and
optionally `parseStderrLine` (turn output lines into `session`, `text`, `tool`,
`permission_denied`, `final` and `error` events). Set `verified: false` until you have run the
adapter against the real CLI. The execution manager does everything else: approval checks,
spawning, timeouts, cancellation, locks, redaction, git and verification.

Tests never call real coding CLIs. `tests/fixtures/mock-cli.mjs` stands in for them;
`installMockCli()` installs it as an npm-style `.cmd` wrapper on Windows, so wrapper
unwrapping is exercised on every run.

## Coding rules

- All SQL uses bound parameters (`db.get(sql, ...params)`). Never build SQL from input.
- Validate untrusted input with Zod (`parseInput`) at the boundary; schemas are strict objects.
- Expected failures throw `UabError` with a code from `src/core/errors.ts`. Codes are part of
  the public contract; do not rename them.
- Never use `exec`/`execSync` or `shell: true` (ESLint blocks `exec`). Start processes only with
  `runProcess` (`src/execution/process.ts`) and a `buildChildEnv` environment.
- Logs go to stderr only. stdout is reserved for MCP JSON-RPC.
