# Admin

Operator tools. Seed and preview users are **not** admin.

## How to get there

`/admin` and its children (`/admin/users`, `/admin/roles`, `/admin/invites`,
`/admin/reserved-usernames`, `/admin/feature-flags`,
`/admin/platform-integrations`, `/admin/provider-marks`, `/admin/codemods`,
`/admin/community-reports`, `/admin/insights`, `/admin/platform-feedback`,
`/admin/system-email`).

## Drive it

```bash
node tools/control-kody.ts request GET /admin 403
```

403 on the seed account is success. Local `kody@example.com` is admin; do not
use it unless the change is an admin surface. The users list accepts
`verification=stalled` for unverified person accounts whose latest signup/verify
send is still `accepted` after 60 minutes.

## APIs

JSON siblings under `/admin/*.json`. Same 403 for the preview seed.
