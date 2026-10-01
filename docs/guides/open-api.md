---
id: open_api
title: Open API and local execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 is available. Call Kody
  over HTTPS at api.kody.codes, mint scoped tokens from the MCP api tool or CLI,
  and run execute modules locally with CapabilityProxy. Behind experiments
  flags; signed-in users can turn them on from this page.
category: platform
---

# Open API and local execute

Open API and local execute are behind the `mcp-api-tool` and `local-execute`
feature flags (experiments cohort in production, plus per-user overrides).
Signed-in users who are not already enabled can turn them on from this page.
They may change or go away.

## What they are

- **Open API** — JSON HTTP at [api.kody.codes](https://api.kody.codes)
  (`/openapi.json` and `/v1/*`). Interactive docs:
  [api-docs.kody.codes](https://api-docs.kody.codes).
- **MCP `api` tool** — run one Open API operation (`operationId` + `params`)
  from a connected agent when `mcp-api-tool` is on. Use it to mint, list, and
  revoke scoped API tokens (`tokenCreate` / `tokenList` / `tokenRevoke`). There
  is no account UI for tokens.
- **Local execute** — `@kodycodes/cli execute --local` runs your module in a
  local workerd and forwards each `kody:runtime` call through the
  CapabilityProxy (`/v1/capability-proxy/session` and
  `/v1/capability-proxy/call`). Needs the `local-execute` flag and a token that
  holds the `local-execute` scope.

## How to get access

1. **Experiments** — turn on experiments at
   [`/account/experiments`](/account/experiments). Production already enables
   `mcp-api-tool` and `local-execute` for the `experiments_opt_in` audience.
2. **This page** — signed-in users can opt in with the button above. That writes
   per-user on overrides for both flags without joining the broader experiments
   cohort.

## Prefer local CLI execute

When **Node ≥22** and `@kodycodes/cli` are available, prefer
`npx @kodycodes/cli execute --local` for one-off modules, smoke tests, and
composition. Fall back to hosted MCP `execute` when local is not appropriate (no
suitable Node, CLI missing, flags/scopes missing, or the host cannot run a local
workerd). Cursor Cloud Agents need `KODY_API_TOKEN` in the environment (not in
the prompt); see [Cursor Cloud Agent notes](../contributing/cloud-agents.md) and
the
[prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
skill.

## First local run

1. With MCP `api` available, mint a short-lived token (value returned once):

   ```json
   {
   	"operationId": "tokenCreate",
   	"params": {
   		"name": "kody-cli-local",
   		"scopes": ["local-execute", "account:read"]
   	}
   }
   ```

   Add scopes as needed for the work. Or from a shell already holding
   `KODY_API_TOKEN` with `tokens:write` and `local-execute`: use the CLI / MCP
   `api` helpers the same way. Prefer MCP `tokenCreate` for the first token.

2. Export the value (do not paste it back into chat):

   ```bash
   export KODY_API_TOKEN='kody_at_…'
   ```

3. Run a local module:

   ```bash
   npx @kodycodes/cli execute --local --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
   ```

   Prefer the env var over `--token` so the secret is not visible in process
   arguments.

List and revoke tokens with MCP `api` (`tokenList`, `tokenRevoke`) or the same
operations over HTTP.

## Metering

Local CPU is not counted as `execute` or `dynamic_worker_day`; capabilities you
call through the proxy still meter normally.

## Where to go next

- [api-docs.kody.codes](https://api-docs.kody.codes) — interactive OpenAPI
- [Runtime and efficiency](./platform-efficiency.md) — how cloud execute meters
  worker days
- Contributor detail:
  [Open API architecture](../contributing/architecture/open-api.md)
