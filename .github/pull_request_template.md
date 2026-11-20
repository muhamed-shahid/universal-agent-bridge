## What and why

<!-- What does this change and why? Link the issue if there is one. -->

## How it was tested

- [ ] `npm run check` passes
- [ ] Tests added or updated (security-relevant changes: `tests/security`)
- [ ] Manually verified with a real CLI (name and version): <!-- or "not applicable" -->

## Safety checklist

- [ ] No new way for a task to run without human approval
- [ ] No shell, no new command or file-write MCP tool
- [ ] No permission-bypass flag can reach an agent
- [ ] Session isolation unchanged (session id + token required, tasks filtered by session)
- [ ] No secrets, tokens, personal paths or private data in code, tests or docs

## Documentation

- [ ] README / docs / CHANGELOG updated for user-visible changes
