# Shared packages

Person-to-person invitations to use a saved package. Owner invites; guest
accepts with pin or follow. Guests read source and invoke. They cannot publish
or write.

## How to get there

`/account/shared` lists outbound and inbound grants. Package settings on
`/@username/:kodyId/settings` invite and revoke. Invite email and the package
page show Accept. Pin-ahead guests use `/@username/:kodyId/approve-changes`.

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/shared.json' \
  --check /account/shared
```

Invite and accept through MCP (`packageShareInvite`, `packageShareAccept`) or
`POST /profiles/:username/packages/:kodyId/share.json`.

## APIs

- `GET|POST /account/shared.json`
- `GET|POST /profiles/:username/packages/:kodyId/share.json`
- `GET|POST /profiles/:username/packages/:kodyId/approve-changes.json`

## Gotchas

- Both accounts must be on a paid plan.
- Accept is required. Invite-before-signup stays pending until the guest has an
  account and pays.
- Pin fails closed when the owner publishes ahead. Follow does not.
- Do not reuse `package_scope_grants` for person accounts.
