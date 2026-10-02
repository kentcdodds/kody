---
id: open_api
title: Open API and local execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 is available. Agents on
  MCP use cliCredentialBootstrap (one-shot code, no tokenCreate); interactive
  humans use kody login; scoped kody_at_… tokens remain for CI/headless. Call
  Kody over HTTPS at api.kody.codes with CapabilityProxy.
category: platform
---

# Open API and local execute

The Open API, MCP `api` tool, and local-execute HTTP surfaces are available to
every signed-in account. Local execute still requires the `local-execute` API
token scope (or CLI `kody login` OAuth on CapabilityProxy routes).

## What they are

- **Open API** — JSON HTTP at [api.kody.codes](https://api.kody.codes)
  (`/openapi.json` and `/v1/*`). Interactive docs:
  [api-docs.kody.codes](https://api-docs.kody.codes).
- **MCP `api` tool** — run one Open API operation (`operationId` + `params`)
  from a connected agent. Use it to mint, list, and revoke scoped API tokens
  (`tokenCreate` / `tokenList` / `tokenRevoke`). There is no account UI for
  tokens.
- **Local execute** — `@kodycodes/cli execute --local` runs your module in a
  local workerd and forwards each `kody:runtime` call through the
  CapabilityProxy (`/v1/capability-proxy/session` and
  `/v1/capability-proxy/call`). Auth: `--token` / `KODY_API_TOKEN` (`kody_at_…`
  with `local-execute` scope), or — when no API token is set — the access token
  from `kody login` (MCP OAuth) as Bearer on CapabilityProxy routes.

## Prefer local CLI execute

When **Node ≥22** and `@kodycodes/cli` are available, prefer
`npx @kodycodes/cli execute --local` for one-off modules, smoke tests, and
composition — including modules that `import` from `kody:@owner/name` (or
`kody:@owner/name/path`). Keep `--local`; do not switch to hosted MCP `execute`
for package imports. Agents already on MCP: `cliCredentialBootstrap` then CLI
`auth bootstrap` (no second OAuth, no `tokenCreate`). Interactive humans:
`kody login` once, then `--local` with no `KODY_API_TOKEN`. Scoped `kody_at_…`
tokens remain valid for CI and other headless envs without MCP — put
`KODY_API_TOKEN` in the environment (not in the prompt). If local cannot run (no
suitable Node, CLI missing, scope/auth missing, or the host cannot run a local
workerd), use Open API / MCP `api` for the needed operations, or fix the
environment so local works — hosted MCP `execute` is banned for agents that can
use local CLI or Open API. See
[Cursor Cloud Agent notes](../contributing/cloud-agents.md) and the
[prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
skill.

### Saved-package imports under `--local`

Modules that `import { kody }` / `workflows` from `kody:runtime` (same contract
as cloud execute — no ambient global `kody`) run in local workerd; each
`kody:runtime` call is a CapabilityProxy hop. Modules with static `kody:@…`
imports keep `--local`: the CLI calls `POST /v1/local-execute/package-graph`
(same `local-execute` scope + login OAuth or API token) to download published,
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

and running `npx @kodycodes/cli execute --local …`.

There is no author-facing `packages.invoke`.

Package-graph prep meters as an observe-only Open API `api_call` (not
`dynamic_worker_day` / cloud execute of the user module). Capability hops during
the later local run still meter normally. Literal `import("kody:@…")` is not
bound for local embedding — use a static import.

**Authenticated fetch and stamped host grants:** package-graph modules embed a
local runtime shim that binds `createAuthenticatedFetch`, `secretHeaders`,
`oauthClientCredentials`, stamped `packageSecrets`, and stamped `packageStorage`
through CapabilityProxy hops (or pure placeholder builders for `secretHeaders`).
`createAuthenticatedFetch` becomes `kody.authenticatedFetch` on origin, which
expands `{{integration-token:…}}` via the same fetch gateway as cloud execute —
long-lived OAuth tokens never enter local workerd. Published bundles that inline
the virtual runtime (instead of importing `.__kody_virtual__/runtime.js`) are
rewritten onto that shim during package-graph prep so Dropbox-style artifacts
work under `--local` without cloud's ALS preload. Stamped `packageStorage` /
`packageSecrets` hop as `kody.packageStorage*` / `kody.packageSecret*` with
per-call ownership / share grant checks. Gmail-style helpers such as
`@kentcdodds/google` and Dropbox helpers such as `@kentcdodds/dropbox` can
complete authenticated outbound fetch under `--local` after package-graph
download (responses over 4 MiB still need cloud execute or a smaller
projection).

Ad hoc modules that import `createAuthenticatedFetch` directly from
`kody:runtime` (not via a stamped `kody:@…` package) still need a CLI runtime
that exports the same CapabilityProxy-backed helper and enters the runtime ALS
before evaluating user code; package imports do not.

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
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

**Preferred for interactive humans:** `kody login`, then run with no
`KODY_API_TOKEN`. The CLI sends the stored MCP OAuth access token as Bearer to
CapabilityProxy and package-graph (same `local-execute` scope).

```bash
npx @kodycodes/cli login   # once
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
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
   npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
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
