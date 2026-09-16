# External secret providers

Kody resolves password-manager credentials the same way it resolves user
secrets: placeholders at the secret-aware `fetch` boundary, never a
`secret_get`. Provider logic lives in saved packages. Kody core stays
provider-agnostic.

## Feature flag

The whole surface is behind the `secret-providers` admin flag (registry default
**off**). Enable it for one account or globally at `/admin/feature-flags`. When
the flag is off:

- `{{secret/<provider>:<ref>}}` is unsupported (clear error, no provider call)
- binding, grants, approval UX, and the account nav item are hidden
- MCP `secretProvider*` capabilities are hidden and denied

Existing `{{secret:name}}` placeholders are unchanged.

## Grammar

`{{secret/<provider>:<ref>}}` splits on the **first** `:` after `secret/`. The
`ref` is opaque to core.

- `{{secret/1password:i/<item-uuid>/password}}` — canonical form
- `{{secret/1password:op://Vault/Item/password}}` — writable synonym only

Existing `{{secret:name}}` user-secret placeholders are unchanged.

## Canonicalization

Grants and the short TTL cache key on the canonical ref `i/<item-uuid>/<field>`.

Core has a small helper that maps `op://<vault>/<item-uuid>/<field>` when the
item segment is already a UUID. Name-based `op://Vault/Item/password` is not
interpreted in core. The bound provider package's sealed `./secretProvider`
export can canonicalize that synonym (`action: "canonicalize"`) and return
`{ canonicalRef }` without a secret value.

Grant approval (`secretProviderLock`) requires a locally canonicalizable ref so
lock/search never call the vault.

## Binding

A saved package may declare it can serve a provider id:

```json
{
	"kody": {
		"secretProvider": { "id": "1password" }
	},
	"exports": {
		"./secretProvider": "./secret-provider.ts"
	}
}
```

Declaring metadata does **not** bind the provider. The account owner pins one
saved package identity to that provider id on `/account/secret-providers` (or
`secretProviderBind`), plus the **Kody user secret** that holds the door key and
optional non-secret config (for example a Connect base URL).

## Sealed resolve

The platform invokes `./secretProvider` only from the fetch boundary, with
`action: "resolve" | "canonicalize"`. The resolve result is
`{ value, hosts: string[] }`. Ordinary `execute`, `packages.invoke`, and
`kody:@` imports of `./secretProvider` are rejected so `value` is never an RPC
or import result.

Timeout budget: **8s** for resolve, **5s** for canonicalize. Empty `hosts`
denies every use. Host match normalizes to hostname, so
`https://app.example.com/login` allows `app.example.com` only. Items with no
usable websites fail closed.

## Grants

- Ad hoc execute may use provider placeholders without a package grant (same
  spirit as unlocked user secrets).
- Saved packages need an explicit `(provider, canonicalRef) → package` grant.
  `secretProviderLock` returns the approval URL; only the owner can grant or
  revoke on `/account/secret-providers`. Unbind does not drop grants.
- Share-granted packages use the **package owner's** binding and grants, not the
  guest's.

Ungranted package use fails **before** the value-returning provider call.

## Cache and failures

Resolved values cache for **30 seconds**, keyed by
`(account, provider, canonicalRef)`. Deduplicate refs in one request. Fail
closed on a missing door-key secret, provider error, missing field, empty hosts,
host mismatch, broken ref, or missing grant. Errors name the next action and
never include values.

Ordinary `search` does not call the provider or crawl a vault.

## Implementing a provider package

1. Declare `kody.secretProvider.id`.
2. Export `./secretProvider`.
3. Accept
   `{ action, ref, canonicalRef, doorSecretName, doorSecretValue, config }`.
4. For `canonicalize`, return `{ canonicalRef }` only.
5. For `resolve`, return `{ value, hosts }` where `hosts` are item websites.
6. Do not log `doorSecretValue` or `value`.

Adding another vendor is a new package plus an account binding, not a Kody core
fork.

See [Secrets](../guides/secrets.md) and
[Secrets and host approval](../use/secrets-and-values.md).
