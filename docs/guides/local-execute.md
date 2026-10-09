---
id: local_execute
title: Local CLI execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 and the CLI are available.
  Orthogonal to Open API: use this guide for CLI setup and --local usage; see
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

Auth: `--token` / `KODY_API_TOKEN` (`kody_at_…` with `org:execute`; add
`package:execute` when the module imports `kody:@…`), or when no API token is
set, the access token from `kody login` (MCP OAuth) as Bearer on CapabilityProxy
and package-graph routes.

## Setup

**Agents already on MCP:** call `cliCredentialBootstrap` with a required
lifetime (single-task agents use `short`). It returns a one-shot `kody_bc_…`
code and a `cli_command` that already includes lifetime flags (**not** a
`kody_at_…`). Run the CLI command (no second OAuth, no `tokenCreate`):

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": { "lifetime": "short" }
}
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
```

`short` is 1 hour idle / 24 hours max. `long` is 14 days idle / 3 months max. Or
pass both `--idle-ttl-seconds` and `--max-lifetime-seconds`. Lifetime is
required; missing it fails with the exact flag syntax.

**Interactive humans:** `kody login` once per machine, then run `--local`
without `KODY_API_TOKEN`.

```bash
npx @kodycodes/cli login   # once
```

**CI / headless only:** scoped `KODY_API_TOKEN` (`kody_at_…` with `org:execute`,
plus `package:execute` for saved-package imports), usually from MCP `api`
`tokenCreate` with a required lifetime. Put the value in the environment; never
paste it into chat. Prefer the env var over `--token`. When set,
`KODY_API_TOKEN` wins over `kody login` / bootstrap store. Minting details:
[Open API](./open-api.md) (`guide:open_api`).

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "kody-cli-local",
		"scopes": ["org:execute", "org:read", "package:execute"],
		"lifetime": "short"
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
CapabilityProxy hops). Package-graph always returns the gateway-fetch shim, so
ad-hoc scripts with no `kody:@` imports still expand `{{secret:…}}` placeholders
on origin (or fail closed naming the secret) instead of sending them raw.

## Failure

- Node is below 22, the CLI is missing, or the host cannot run workerd. Use
  [Open API](./open-api.md) / MCP `api`, or fix the environment. Hosted MCP
  `execute` stays banned for that failure case.
- Bootstrap or redeem rejects a missing lifetime. Pass `--lifetime short|long`
  (or both idle/max flags). Call `cliCredentialBootstrap` again with
  `lifetime: "short"` if the code expired.
- The module imports `kody:@…`. Keep `--local`.
- Auth priority for `--local`: `--token` / `KODY_API_TOKEN`, then the stored
  bootstrap token, then `kody login`.
