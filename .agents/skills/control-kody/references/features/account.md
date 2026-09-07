# Account hub

Signed-in home: profile, export, logout, delete, and links to the other account
surfaces. Logout lives at the bottom of this page, not in the site header.
Desktop puts an Account link in the header to the left of the avatar; narrower
viewports keep Account in the menu panel. The header avatar goes to the public
profile (`/@username`).

## How to get there

`/account` after login. Account deletion is `/account/delete`.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/profile.json
node tools/control-kody.ts request GET /account/connected-agents.json
```

## APIs

- `GET|POST /account/profile.json`
- `POST /account/profile/avatar.json`
- `POST /account/email-change.json`
- `POST /account/email-claim-release.json`
- `GET /account/export.json`
- `POST /account/delete`
- `GET|POST /account/connections.json`
- `GET|POST /account/connected-agents.json`
- `POST /logout` (form at the bottom of this page)

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
- Connected agents lists inbound OAuth hosts grouped by display name (logos for
  known kinds, newest-first, best-effort labels, per-`clientId` revoke). That
  list is not `users.mcp_client_name` and not minted MCP OAuth clients.
- Former-address release is `POST /account/email-claim-release.json`, then
  confirm at `/verify-email-claim-release`. It drops the claim without reminting
  `users.stable_user_id`.
