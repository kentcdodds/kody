# Integrations and OAuth connect

Saved OAuth connections and the hosted connect start.

## How to get there

`/account/integrations` → `/account/integrations/:integrationName`. OAuth apps:
`/account/integrations/apps/:appSlug`. One-click grant:
`/account/integrations/approve`. Start connect: `/connect/oauth`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/integrations.json
```

## APIs

- `GET|POST /account/integrations.json`
- `/connect/oauth` (browser; needs a real provider client)

## Gotchas

- Cloud Agents cannot complete a third-party OAuth dance without credentials in
  the environment. HTTP list/empty-state is the usual proof.
- `/guides/connect` is the public how-to, not the account page.
