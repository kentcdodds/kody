---
id: local_execute
title: Local CLI execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 and the CLI are available.
  Orthogonal to Open API — use this guide for CLI setup and --local usage; see
  guide:open_api for HTTPS / MCP api fallback.
category: platform
---

# Local CLI execute

When **Node ≥22** and `@kodycodes/cli` are available, prefer
`npx @kodycodes/cli execute --local` for one-off modules, smoke tests, and
composition. Local execute is **orthogonal** to Open API: the CLI runs your
module in a local workerd and forwards each `kody:runtime` call through the
CapabilityProxy. Do **not** use hosted MCP `execute` for agent work when a local
or Open API path exists.

Auth: `--token` / `KODY_API_TOKEN` (`kody_at_…` with `local-execute` scope), or
— when no API token is set — the access token from `kody login` (MCP OAuth) as
Bearer on CapabilityProxy and package-graph routes.

## Setup

**Agents already on MCP** — call `cliCredentialBootstrap` (MCP `api` /
`kody.cliCredentialBootstrap`). It returns a one-shot `kody_bc_…` code and a
`cli_command` — **not** a `kody_at_…`. Run the CLI command (no second OAuth, no
`tokenCreate`):

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": {}
}
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'   # from cli_command
```

**Interactive humans** — `kody login` once per machine, then run `--local`
without `KODY_API_TOKEN`.

```bash
npx @kodycodes/cli login   # once
```

**CI / headless only** — scoped `KODY_API_TOKEN` (`kody_at_…` with
`local-execute` scope), usually from MCP `api` `tokenCreate`. Put the value in
the environment; never paste it into chat. Prefer the env var over `--token`.
When set, `KODY_API_TOKEN` wins over `kody login` / bootstrap store. Minting
details: [Open API](./open-api.md) (`guide:open_api`).

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
export KODY_API_TOKEN='kody_at_…'
```

## Usage

```bash
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Use `--file path.ts` the same way when the module lives on disk. Keep `--local`;
static `kody:@owner/name` imports still run locally (package-graph download +
CapabilityProxy hops). There is no author-facing `packages.invoke`.

See [Cursor Cloud Agent notes](../contributing/cloud-agents.md) and the
[prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
skill.

## Saved-package imports

Modules that `import { kody }` / `workflows` from `kody:runtime` (same contract
as cloud execute — no ambient global `kody`) run in local workerd; each
`kody:runtime` call is a CapabilityProxy hop. Modules with static `kody:@…`
imports keep `--local`: the CLI calls `POST /v1/local-execute/package-graph`
(API tokens need `local-execute` scope; CLI login OAuth does not) to download
published, stamped importable-module artifacts, embeds them next to your module

- `kody:runtime`, and still uses CapabilityProxy only for per-call runtime hops.
  There is **no** silent whole-module defer to CapabilityProxy → `kody.execute`.
  Agents keep writing:

```ts
import { searchMessages } from 'kody:@kentcdodds/google/gmail'
export default async function main(params) {
	return await searchMessages(params)
}
```

and running `npx @kodycodes/cli execute --local …`.

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
long-lived OAuth tokens never enter local workerd. Published modules that use
ambient `fetch` with `{{secret:…}}` placeholders are rewritten during
package-graph prep: quoted secret literals become `__kodySecretRef(...)`, and
`fetch` is rebound to `kody.gatewayFetch` so expansion still happens on origin
(missing secrets fail closed before any third-party request). Static `kody:@…`
import proxies wrap function exports in `__kodyMeterStaticPackageExport` so
nested inlined callees run under that package's stamp ALS. gatewayFetch prefers
the meter stamp over the outer module-path binding so nested callees use
stamp-aligned package-scoped secrets. Published bundles that **call**
`__kodyMeterStaticPackageExport` as a free binding (cloud preload) are rewritten
to import it from the local runtime shim — otherwise `--local` throws
`__kodyMeterStaticPackageExport is not defined` before nested secret-aware fetch
can run (same class as Discord `edit-message` / `send-shipped-pr` under packages
that inline nested `kody:@…` deps). Published bundles that inline the virtual
runtime (instead of importing `.__kody_virtual__/runtime.js`) are rewritten onto
that shim during package-graph prep so Dropbox-style artifacts work under
`--local` without cloud's ALS preload. Stamped `packageStorage` /
`packageSecrets` hop as `kody.packageStorage*` / `kody.packageSecret*` with
per-call ownership / share grant checks. Gmail-style helpers such as
`@kentcdodds/google`, Dropbox helpers such as `@kentcdodds/dropbox`, and
secret-backed helpers such as `@kentcdodds/fathom-analytics` can complete
authenticated outbound fetch under `--local` after package-graph download
(responses over 4 MiB still need cloud execute or a smaller projection).

Ad hoc modules that import `createAuthenticatedFetch` directly from
`kody:runtime` (not via a stamped `kody:@…` package) still need a CLI runtime
that exports the same CapabilityProxy-backed helper and enters the runtime ALS
before evaluating user code; package imports do not.

## Metering

Local CPU for modules that run in workerd (including embedded `kody:@…` package
modules after package-graph download) is not counted as `execute` or
`dynamic_worker_day`; capabilities you call through the proxy still meter
normally. The package-graph prep call meters as an observe-only Open API
`api_call` (`localExecutePackageGraph`), not a full cloud execute.

## Fallback

If `--local` cannot run (no suitable Node, CLI missing, scope/auth missing, or
the host cannot run local workerd), use Open API / MCP `api`, or fix the
environment — hosted MCP `execute` is banned for agents that can use local CLI
or Open API. Details for HTTPS, tokens, and the `api` tool:
`search({ entity: "guide:open_api" })` or [Open API](./open-api.md).
