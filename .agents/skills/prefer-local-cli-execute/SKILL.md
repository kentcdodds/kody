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

## Mint a token (once per machine / env)

Use MCP `api` (or Open API `tokenCreate`) — the value is returned **once**. Put
it in env or `--token`; **never paste the token into chat**.

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "kody-cli-local",
		"scopes": ["local-execute", "account:read"]
	}
}
```

Add scopes as needed for the work (for example `packages:read`). Cloud Agents
need `KODY_API_TOKEN` in the environment (Cursor environment secrets / vars),
not in the prompt.

```bash
export KODY_API_TOKEN='kody_at_…'   # do this yourself; never paste into chat
```

## Run locally

```bash
npx @kodycodes/cli execute --local --token "$KODY_API_TOKEN" --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

`--token` is optional when `KODY_API_TOKEN` is already set.

## Fallback

Use hosted MCP `execute` when local is not appropriate: no Node ≥22, CLI
unavailable, flags/scopes missing, or the host cannot run a local workerd.

## Where agent guidance lives

Layer choice (MCP overlay vs package docs vs memories):
[Where agent guidance lives](https://kody.codes/docs/agent-guidance)
(`guide:agent_guidance`). Cloud Agent VM notes:
[docs/contributing/cloud-agents.md](../../../docs/contributing/cloud-agents.md).
