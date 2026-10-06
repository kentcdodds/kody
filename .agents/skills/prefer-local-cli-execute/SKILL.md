---
name: prefer-local-cli-execute
description: >
  Prefer @kodycodes/cli execute --local over hosted MCP execute for one-off
  modules and smoke tests when Node ≥22 and the CLI are available. Agents
  already on Kody MCP: cliCredentialBootstrap then CLI auth bootstrap (no second
  OAuth, no tokenCreate). Interactive humans: kody login. Scoped KODY_API_TOKEN
  remains for CI/headless. Use when running Kody execute from Cursor (including
  Cloud Agents), bootstrapping CLI credentials, or choosing local CLI vs Open
  API / MCP `api`.
---

# Prefer local CLI execute

When Node is 22 or newer and `@kodycodes/cli` is available, run one-off modules
with local execute. Do not use hosted MCP `execute`. This skill and
[Local CLI execute](https://kody.codes/docs/local-execute)
(`guide:local_execute`,
[docs/guides/local-execute.md](../../../docs/guides/local-execute.md)) are the
source of truth. Open API fallback: [Open API](https://kody.codes/docs/open-api)
(`guide:open_api`).

## Command

Agents already on MCP: call `cliCredentialBootstrap` (MCP `api`), then run the
returned `cli_command`. Humans who can finish browser OAuth:
`npx @kodycodes/cli login` once. CI with no MCP session and no interactive
login: set `KODY_API_TOKEN` in the environment. Never paste a `kody_at_…` into
chat.

```bash
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Saved packages keep `--local` and a static `kody:@…` import.

## Failure

- Node is below 22, the CLI is missing, or the host cannot run workerd. Use Open
  API / MCP `api`, or fix the environment. Hosted MCP `execute` stays banned.
- The bootstrap code is rejected. Call `cliCredentialBootstrap` again. Do not
  switch to `kody login` or `tokenCreate` while an MCP session exists.
- `search` is forbidden. Default bootstrap scopes are `local-execute` and
  `account:read`
  ([ADR 0056](../../../docs/contributing/decisions/0056-cli-credential-bootstrap.md)).
  `whoami` works. Use MCP `search`, or a token with `search:read`.
- The module imports `kody:@…`. Keep `--local`.
- The CLI asks for a login, a bootstrap, or a token. Priority is `--token` /
  `KODY_API_TOKEN`, then the stored bootstrap token, then `kody login`.
