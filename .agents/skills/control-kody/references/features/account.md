# Account hub

Signed-in home: profile, sign-in providers, export, logout, delete, and links to
the other account surfaces. Logout lives at the bottom of this page, not in the
site header. Desktop puts an Account link in the header to the left of the
avatar; narrower viewports keep Account in the menu panel. The header avatar
goes to the public profile (`/@username`).

The account rail ("Account sections") lists every account page plus Repositories
(`/@username`, the canonical repository list) and Connections
(`/account/connections`, connected agents). Experiments opt-in lives at
`/account/experiments`. The rail is rendered by `AccountPageHeader` in
`packages/worker/client/routes/account-management-components.tsx`. Below 860px
it collapses to a `<details>` menu. On short pages the rail scrolls inside the
content box.

## How to get there

`/account` after login. Account deletion is `/account/delete`.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/profile.json
node tools/control-kody.ts request GET /account/connections.json
```

## APIs

- `GET|POST /account/profile.json`
- `POST /account/profile/avatar.json`
- `POST /account/email-change.json`
- `POST /account/email-claim-release.json`
- `GET /account/export.json`
- `POST /account/delete`
- `GET|POST /account/connections.json` (sign-in providers: GitHub, Google, X,
  Discord)
- `POST /logout` (form at the bottom of this page)

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
- Connected agents (inbound MCP hosts) are not on this page. They live on
  [connections](./connections.md) at `/account/connections`; Overview only links
  there.
- Former-address release is `POST /account/email-claim-release.json`, then
  confirm at `/verify-email-claim-release`. It drops the claim without reminting
  `users.stable_user_id`.
- Email destinations are managed on the [email inbox](./email.md).
