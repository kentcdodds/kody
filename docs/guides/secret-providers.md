---
id: secret_providers
title: Custom secret providers
summary:
  Use credentials from an external vault in secret-aware fetch without the agent
  ever reading them. Behind a feature flag; signed-in users can turn it on from
  this page.
category: platform
---

# Custom secret providers

Custom secret providers are behind the `secret-providers` feature flag because
they may change or go away. Signed-in users can turn them on from this page.

A custom secret provider lets your agent use a password-manager item the same
way it uses a Kody secret: a placeholder in `fetch`, resolved at the network
boundary. The model never sees the value. User secrets use `{{secret:name}}`;
providers use `{{secret/<provider>:<ref>}}`.

Provider packages declare an id such as `1password`. Provider logic lives in a
saved package you bind; Kody core does not talk to the vault itself.

## Turn it on

The account UI and `secretProvider*` capabilities stay hidden until the flag is
on for you. Use the button at the top of this page.

## Bind a provider

1. Save the vault door key as a Kody user secret. Paste it on
   `/account/secrets/new`, never into chat. URL shape:
   [Secret setup URL reference](./account-secret-setup.md).
2. Have a saved package that declares `kody.secretProvider.id` (for example
   `1password`) and exports `./secretProvider`.
3. Bind that package on `/account/secret-providers` (`secretProviderBind`):
   provider id, package, door-key secret name, and optional non-secret config.

Declaring metadata on a package does not bind it. Only the account owner can
bind or unbind. Unbind, and rebind to a different package, drop every grant for
that provider.

## Use a placeholder

In secret-aware `fetch`:

```
{{secret/1password:i/<item-uuid>/password}}
```

`op://Vault/<item-uuid>/password` is a writable synonym that canonicalizes to
the same grant key when the item segment is a UUID. Name-based vault paths are
not interpreted in Kody core.

The item's websites are the host allowlist. Empty websites refuse the fetch. The
request URL must be `https:`.

Ad hoc execute does not need a package grant. Saved packages do:
`secretProviderLock` returns the Allow URL; grant and revoke on
`/account/secret-providers`. Shared packages use the **owner's** binding and
grants, not the guest's.

Search does not crawl vaults. `secretProviderList` returns binding metadata
only.

## MCP

Search `secretProviderList` / `secretProviderBind` / `secretProviderLock` first;
open capability detail for the exact call shape.

## Where to go next

- [Secrets](./secrets.md) — the no-`secret_get` rule, placeholders, and host
  approval
