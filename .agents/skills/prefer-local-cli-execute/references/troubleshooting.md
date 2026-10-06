# Local CLI execute troubleshooting

Rules live in [SKILL.md](../SKILL.md). This file is the command cookbook. This
skill and `guide:local_execute` stay the source of truth. Do not invent a second
policy, and do not switch to hosted MCP `execute` from here.

## Agents already on MCP: bootstrap

Call `cliCredentialBootstrap` (MCP `api` / `kody.cliCredentialBootstrap`). It
returns a one-shot `kody_bc_…` code and `cli_command`, never a `kody_at_…`. Run
that CLI command (or pipe the code into it). The CLI redeems over HTTPS and
stores the API token locally.

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": {}
}
```

Then run the returned `cli_command` (example shape). Import `kody` from
`kody:runtime`. Same as cloud execute. There is no ambient global `kody`:

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Never paste a `kody_at_…` into chat. The bootstrap code is short-lived and
one-shot. Prefer running `cli_command` over retyping secrets.

After bootstrap, CLI commands reuse the stored bootstrap token the same way
`--local` does (cli ≥1.8.1). Default bootstrap scopes are `local-execute` and
`account:read`
([ADR 0056](../../../../docs/contributing/decisions/0056-cli-credential-bootstrap.md)):
`whoami` works. `search` needs `search:read` (use MCP `search`, or mint a token
that includes that scope).

If bootstrap fails, rerun `cliCredentialBootstrap` for a fresh code. Do not fall
through to `kody login` or `tokenCreate` while an MCP session exists.

## Interactive humans: `kody login`

When a human can complete browser OAuth on the machine:

```bash
npx @kodycodes/cli login   # once per machine
npx @kodycodes/cli execute --local --code '…'
```

CapabilityProxy and package-graph accept that OAuth Bearer (ADR 0055). API
tokens still need the `local-execute` scope. CLI login OAuth does not.

## Credential priority

1. `--token` / `KODY_API_TOKEN` (scoped `kody_at_…`) when set
2. Else stored API token from `auth bootstrap` / env
3. Else stored CLI MCP OAuth from `kody login`
4. Else a clear "login, bootstrap, or provide a token" error

Prefer the env var over `--token` so the secret is not visible in process
arguments.

## CI / headless without MCP

Use MCP `api` `tokenCreate` (or a pre-provisioned `KODY_API_TOKEN` in
environment secrets) only when there is no MCP session to bootstrap from and no
interactive login (classic CI). Write the value only into the environment. Never
paste the token into chat.

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

## Saved-package imports

Saved-package imports work under `--local` too. Keep the flag and write the
usual static import. There is no author-facing `packages.invoke`.

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
[Local CLI execute](../../../../docs/guides/local-execute.md).

## When `--local` cannot run

| Symptom                                              | What to do                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Node is below 22, or `@kodycodes/cli` is missing     | Fix the environment so local works, or use Open API / MCP `api` for the needed operations.                                  |
| Flag or scope error (`local-execute`, `search:read`) | Bootstrap or mint a token with the scope named in the error. `whoami` works on default bootstrap scopes. `search` does not. |
| Host cannot run a local workerd                      | Use Open API / MCP `api`, or move to a host that can run workerd.                                                           |
| Module imports `kody:@…`                             | Keep `--local`. Package-graph fetches the stamped module.                                                                   |
| Hosted MCP `execute` looks easier                    | Leave it unused. It is banned when local CLI or Open API can do the work.                                                   |

Open API reference: [Open API](https://kody.codes/docs/open-api)
(`guide:open_api`).
