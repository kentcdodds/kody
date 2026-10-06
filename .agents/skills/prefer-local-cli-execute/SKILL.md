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

For one-off modules, authenticated smoke tests, and composition, prefer
`npx @kodycodes/cli execute --local` when **Node ≥22** and `@kodycodes/cli` are
available. Do **not** use hosted MCP `execute`.

This skill and [Local CLI execute](https://kody.codes/docs/local-execute)
(`search({ entity: "guide:local_execute" })` or
[docs/guides/local-execute.md](../../../docs/guides/local-execute.md)) are the
source of truth for that rule. Open API fallback:
[Open API](https://kody.codes/docs/open-api) (`guide:open_api`).

Command shapes, scopes, package-graph, and failures:
[references/troubleshooting.md](./references/troubleshooting.md).

## Rules

1. **Agents already on MCP.** Call `cliCredentialBootstrap` (MCP `api` /
   `kody.cliCredentialBootstrap`), then run the returned `cli_command`. Do not
   run interactive `kody login` and do not call `tokenCreate`. Bootstrap returns
   a one-shot `kody_bc_…` code plus `cli_command`, never a `kody_at_…`. Never
   paste a `kody_at_…` into chat.
2. **Interactive humans.** When a human can complete browser OAuth on the
   machine, `npx @kodycodes/cli login` once, then `execute --local`.
3. **CI / headless without an MCP session and without interactive login.** Use a
   scoped `KODY_API_TOKEN` (`tokenCreate` or a pre-provisioned environment
   secret). Write the value only into the environment. Never paste the token
   into chat.
4. **Credential priority.** `--token` / `KODY_API_TOKEN` (scoped `kody_at_…`)
   when set, else the stored API token from `auth bootstrap` / env, else stored
   CLI MCP OAuth from `kody login`, else a clear "login, bootstrap, or provide a
   token" error.
5. **Saved packages.** Keep `--local` and write the usual static `kody:@…`
   import. There is no author-facing `packages.invoke`. Do not drop `--local`
   merely because the module imports `kody:@…`.
6. **Fallback.** If `--local` cannot run (no Node ≥22, CLI missing, flags or
   scopes missing, or the host cannot run a local workerd), use Open API / MCP
   `api` for the needed operations, or fix the environment so local works.
   Hosted MCP `execute` is banned for agents that can use local CLI or Open API.

Layer choice (MCP overlay vs package docs vs memories):
[Where agent guidance lives](https://kody.codes/docs/agent-guidance)
(`guide:agent_guidance`). Cloud Agent VM notes:
[docs/contributing/cloud-agents.md](../../../docs/contributing/cloud-agents.md).
