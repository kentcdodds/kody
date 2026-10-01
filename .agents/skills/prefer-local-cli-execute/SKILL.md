---
name: prefer-local-cli-execute
description: >
  Prefer @kodycodes/cli execute --local over hosted MCP execute for one-off
  modules and smoke tests when Node ≥22 and the CLI are available. Use when
  running Kody execute from Cursor (including Cloud Agents), minting a
  KODY_API_TOKEN, or choosing between CLI --local and MCP execute.
---

# Prefer local CLI execute

For one-off modules, authenticated smoke tests, and composition, prefer the
local CLI over hosted MCP `execute` when **Node ≥22** and `@kodycodes/cli` are
available.

Canonical guide: [Open API and local execute](https://kody.codes/docs/open-api)
(`search({ entity: "guide:open_api" })` or
[docs/guides/open-api.md](../../../docs/guides/open-api.md)).

## Auth for `--local`

Priority:

1. `--token` / `KODY_API_TOKEN` (scoped `kody_at_…`) when set
2. Else the stored CLI MCP OAuth access token from `kody login` (no
   under-the-hood `tokenCreate`)
3. Else a clear “login or provide a token” error

When you already ran `kody login`, skip minting a temporary API token for local
execute. CapabilityProxy and package-graph accept that OAuth Bearer when the
`local-execute` flag is on.

## Mint a token (agents / CI / optional)

Use MCP `api` (or Open API `tokenCreate`) when you need a scoped token — the
value is returned **once** in that tool result. Write it only into the
environment (shell/`KODY_API_TOKEN`); **never paste the token into chat** again
afterward. Cloud Agents still typically use `KODY_API_TOKEN` in environment
secrets rather than interactive `kody login`.

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "kody-cli-local",
		"scopes": ["local-execute", "account:read"]
	}
}
```

Add scopes as needed for the work (for example `packages:read`).

```bash
export KODY_API_TOKEN='kody_at_…'   # do this yourself; never paste into chat
```

## Run locally

```bash
npx @kodycodes/cli execute --local --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Prefer `KODY_API_TOKEN` in the environment over `--token` so the secret is not
visible in process arguments. With only `kody login`, omit the env var.

Saved-package imports work under `--local` too — keep the flag and write the
usual static import (there is no author-facing `packages.invoke`):

```bash
npx @kodycodes/cli execute --local --code 'import { searchMessages } from "kody:@kentcdodds/google/gmail"
export default async function main(params) { return await searchMessages(params) }'
```

The CLI downloads stamped modules via Open API
`POST /v1/local-execute/package-graph` (same `local-execute` flag + API token or
login OAuth) and embeds them in local workerd. CapabilityProxy stays for
per-call `kody:runtime` hops only — there is no silent whole-module
`kody.execute` defer. Network + auth are still required for package-graph and
capability hops. Stamped package modules bind `createAuthenticatedFetch`,
`packageSecrets`, and `packageStorage` through CapabilityProxy (OAuth tokens
stay on origin). See
[Open API and local execute](../../../docs/guides/open-api.md).

## Fallback

Use hosted MCP `execute` when local is not appropriate: no Node ≥22, CLI
unavailable, flags/scopes missing, or the host cannot run a local workerd. Do
**not** drop `--local` merely because the module imports `kody:@…`.

## Where agent guidance lives

Layer choice (MCP overlay vs package docs vs memories):
[Where agent guidance lives](https://kody.codes/docs/agent-guidance)
(`guide:agent_guidance`). Cloud Agent VM notes:
[docs/contributing/cloud-agents.md](../../../docs/contributing/cloud-agents.md).
