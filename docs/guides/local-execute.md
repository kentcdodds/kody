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

## Setup

**Agents already on MCP** — call `cliCredentialBootstrap` (MCP `api` /
`kody.cliCredentialBootstrap`). It returns a one-shot `kody_bc_…` code and a
`cli_command` — **not** a `kody_at_…`. Run the CLI command (no second OAuth, no
`tokenCreate`):

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
```

**Interactive humans** — `kody login` once per machine, then run `--local`
without `KODY_API_TOKEN`.

**CI / headless only** — scoped `KODY_API_TOKEN` (`kody_at_…` with
`local-execute` scope), usually from MCP `api` `tokenCreate`. Put the value in
the environment; never paste it into chat.

## Usage

```bash
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Use `--file path.ts` the same way when the module lives on disk. Keep `--local`;
static `kody:@owner/name` imports still run locally (package-graph download +
CapabilityProxy hops). There is no author-facing `packages.invoke`.

## Example

```bash
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"
export default async function main() {
  return await kody.search({ query: "memory" })
}'
```

## Fallback

If `--local` cannot run (no suitable Node, CLI missing, flags/scopes missing, or
the host cannot run local workerd), use Open API / MCP `api`, or fix the
environment. Details for HTTPS, tokens, and the `api` tool:
`search({ entity: "guide:open_api" })` or
[Open API and local execute](./open-api.md).
