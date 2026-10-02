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

For one-off modules, authenticated smoke tests, and composition, prefer the
local CLI when **Node ≥22** and `@kodycodes/cli` are available. Do **not** use
hosted MCP `execute`.

Canonical guide: [Local CLI execute](https://kody.codes/docs/local-execute)
(`search({ entity: "guide:local_execute" })` or
[docs/guides/local-execute.md](../../../docs/guides/local-execute.md)). Open API
fallback: [Open API](https://kody.codes/docs/open-api) (`guide:open_api`).

## Agents already on MCP: bootstrap (no second OAuth)

Do **not** run interactive `kody login` and do **not** call `tokenCreate` for
local execute when you already have a Kody MCP session. Call
`cliCredentialBootstrap` (MCP `api` / `kody.cliCredentialBootstrap`) — it
returns a one-shot `kody_bc_…` code + `cli_command`, **never** a `kody_at_…`.
Run that CLI command (or pipe the code into it). The CLI redeems over HTTPS and
stores the API token locally.

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": {}
}
```

Then run the returned `cli_command` (example shape). Import `kody` from
`kody:runtime` — same as cloud execute; there is no ambient global `kody`:

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Never paste a `kody_at_…` into chat. The bootstrap code is short-lived and
one-shot; prefer running `cli_command` over retyping secrets.

After bootstrap, CLI `whoami` / `search` (and similar) reuse the stored
bootstrap token the same way `--local` does (cli ≥1.8.1).

## Interactive humans: `kody login`

When a human can complete browser OAuth on the machine:

```bash
npx @kodycodes/cli login   # once per machine
npx @kodycodes/cli execute --local --code '…'
```

CapabilityProxy and package-graph accept that OAuth Bearer (ADR 0055). API
tokens still need the `local-execute` scope; CLI login OAuth does not.

## CLI credential priority

1. `--token` / `KODY_API_TOKEN` (scoped `kody_at_…`) when set
2. Else stored API token from `auth bootstrap` / env
3. Else stored CLI MCP OAuth from `kody login`
4. Else a clear “login, bootstrap, or provide a token” error

## Optional: scoped API token (CI / headless without MCP)

Use MCP `api` `tokenCreate` (or a pre-provisioned `KODY_API_TOKEN` in
environment secrets) only when there is no MCP session to bootstrap from and no
interactive login — classic CI. Write the value only into the environment;
**never paste the token into chat**.

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "kody-cli-local",
		"scopes": ["local-execute", "account:read"]
	}
}
```

```bash
export KODY_API_TOKEN='kody_at_…'   # do this yourself; never paste into chat
npx @kodycodes/cli execute --local --code '…'
```

Prefer the env var over `--token` so the secret is not visible in process
arguments.

## Saved-package imports

Saved-package imports work under `--local` too — keep the flag and write the
usual static import (there is no author-facing `packages.invoke`):

```bash
npx @kodycodes/cli execute --local --code 'import { searchMessages } from "kody:@kentcdodds/google/gmail"
export default async function main(params) { return await searchMessages(params) }'
```

The CLI downloads stamped modules via Open API
`POST /v1/local-execute/package-graph` (API tokens need `local-execute` scope;
CLI login OAuth does not) and embeds them in local workerd. CapabilityProxy
stays for per-call `kody:runtime` hops only. Package-graph rewrites inlined
virtual runtime preambles onto the CapabilityProxy shim so Dropbox-style
published bundles get a callable `createAuthenticatedFetch` under `--local`. See
[Local CLI execute](../../../docs/guides/local-execute.md).

## Fallback

Do **not** use hosted MCP `execute`. If `--local` cannot run (no Node ≥22, CLI
missing, flags/scopes missing, or the host cannot run a local workerd), use Open
API / MCP `api` for the needed operations, or fix the environment so local
works. Hosted MCP `execute` is banned for agents that can use local CLI or Open
API. Do **not** drop `--local` merely because the module imports `kody:@…`.

## Where agent guidance lives

Layer choice (MCP overlay vs package docs vs memories):
[Where agent guidance lives](https://kody.codes/docs/agent-guidance)
(`guide:agent_guidance`). Cloud Agent VM notes:
[docs/contributing/cloud-agents.md](../../../docs/contributing/cloud-agents.md).
