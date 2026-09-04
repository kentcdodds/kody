# Account hub

Signed-in home: profile, export, logout, delete, and links to the other account
surfaces. Logout lives at the bottom of this page, not in the site header.

## How to get there

`/account` after login. Account deletion is `/account/delete`.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/profile.json
```

## APIs

- `GET|POST /account/profile.json`
- `POST /account/profile/avatar.json`
- `POST /account/email-change.json`
- `GET /account/export.json`
- `POST /account/delete`
- `GET|POST /account/connections.json`
- `POST /logout` (form at the bottom of this page)

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
