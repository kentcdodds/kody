---
id: open_api
title: Open API and local execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 is available. Agents on
  MCP use cliCredentialBootstrap (one-shot code, no tokenCreate); interactive
  humans use kody login; scoped kody_at_… tokens remain for CI/headless. Call
  Kody over HTTPS at api.kody.codes with CapabilityProxy. Behind experiments
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
  `/v1/capability-proxy/call`). Needs the `local-execute` flag. Auth: `--token`
  / `KODY_API_TOKEN` (`kody_at_…` with `local-execute` scope), or — when no API
  token is set — the access token from `kody login` (MCP OAuth) as Bearer.

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
composition — including modules that `import` from `kody:@owner/name` (or
`kody:@owner/name/path`). Keep `--local`; do not switch to hosted MCP `execute`
for package imports. Agents already on MCP: `cliCredentialBootstrap` then CLI
`auth bootstrap` (no second OAuth, no `tokenCreate`). Interactive humans:
`kody login` once, then `--local` with no `KODY_API_TOKEN`. Scoped `kody_at_…`
tokens remain valid for CI and other headless envs without MCP — put
`KODY_API_TOKEN` in the environment (not in the prompt). Fall back to hosted MCP
`execute` only when local is not appropriate (no suitable Node, CLI missing,
flags/scopes missing, or the host cannot run a local workerd). See
[Cursor Cloud Agent notes](../contributing/cloud-agents.md) and the
[prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
skill.

### Saved-package imports under `--local`

Pure `kody.*` / `workflows.create` modules run in local workerd; each
`kody:runtime` call is a CapabilityProxy hop. Modules with static `kody:@…`
imports keep `--local`: the CLI calls `POST /v1/local-execute/package-graph`
(same `local-execute` flag + login OAuth or API token) to download published,
stamped importable-module artifacts, embeds them next to your module +
`kody:runtime`, and still uses CapabilityProxy only for per-call runtime hops.
There is **no** silent whole-module defer to CapabilityProxy → `kody.execute`.
Agents keep writing:

```ts
import { searchMessages } from 'kody:@kentcdodds/google/gmail'
export default async function main(params) {
	return await searchMessages(params)
}
```

and running `npx @kodycodes/cli execute --local …`. There is no author-facing
`packages.invoke`.

Package-graph prep meters as an observe-only Open API `api_call` (not
`dynamic_worker_day` / cloud execute of the user module). Capability hops during
the later local run still meter normally. Literal `import("kody:@…")` is not
bound for local embedding yet — use a static import.

**Authenticated fetch and stamped host grants:** package-graph modules embed a
local runtime shim that binds `createAuthenticatedFetch`, stamped
`packageSecrets`, and stamped `packageStorage` through CapabilityProxy hops.
`createAuthenticatedFetch` becomes `kody.authenticatedFetch` on origin, which
expands `{{integration-token:…}}` via the same fetch gateway as cloud execute —
long-lived OAuth tokens never enter local workerd. Stamped `packageStorage` /
`packageSecrets` hop as `kody.packageStorage*` / `kody.packageSecret*` with
per-call ownership / share grant checks. Gmail-style helpers such as
`@kentcdodds/google` can complete authenticated outbound fetch under `--local`
after package-graph download (responses over 4 MiB still need cloud execute or a
smaller projection).

Ad hoc modules that import `createAuthenticatedFetch` directly from
`kody:runtime` (not via a stamped `kody:@…` package) still need a CLI runtime
that exports the same CapabilityProxy-backed helper; package imports do not.

CLI consumer: [kody-bot/cli#13](https://github.com/kody-bot/cli/pull/13).

## First local run

**Preferred for agents already on MCP:** call `cliCredentialBootstrap` (MCP
`api` / `kody.cliCredentialBootstrap`). It returns a one-shot `kody_bc_…`
bootstrap code and a `cli_command` — **not** a `kody_at_…`. Run the CLI command;
the CLI redeems over HTTPS and stores the API token for `--local`. No second
interactive OAuth and no `tokenCreate`.

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": {}
}
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'   # from cli_command
npx @kodycodes/cli execute --local --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

**Preferred for interactive humans:** `kody login`, then run with no
`KODY_API_TOKEN`. The CLI sends the stored MCP OAuth access token as Bearer to
CapabilityProxy and package-graph (same `local-execute` flag).

```bash
npx @kodycodes/cli login   # once
npx @kodycodes/cli execute --local --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

**Optional — scoped API token** (CI / headless without MCP, or thinner scopes):

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

2. Export the value (do not paste it back into chat):

   ```bash
   export KODY_API_TOKEN='kody_at_…'
   ```

3. Run a local module:

   ```bash
   npx @kodycodes/cli execute --local --code 'export default async function main() { return await kody.metaGetCurrentUser({}) }'
   ```

   Prefer the env var over `--token`. When set, `KODY_API_TOKEN` wins over
   `kody login` / bootstrap store.

List and revoke API tokens with MCP `api` (`tokenList`, `tokenRevoke`) or the
same operations over HTTP.

## Metering

Local CPU for modules that run in workerd (including embedded `kody:@…` package
modules after package-graph download) is not counted as `execute` or
`dynamic_worker_day`; capabilities you call through the proxy still meter
normally. The package-graph prep call meters as an observe-only Open API
`api_call` (`localExecutePackageGraph`), not a full cloud execute.

## Where to go next

- [api-docs.kody.codes](https://api-docs.kody.codes) — interactive OpenAPI
- [Runtime and efficiency](./platform-efficiency.md) — how cloud execute meters
  worker days
- Contributor detail:
  [Open API architecture](../contributing/architecture/open-api.md)
