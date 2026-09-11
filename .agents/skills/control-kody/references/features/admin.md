# Admin

Operator tools. Seed and preview users are **not** admin.

## How to get there

`/admin` and its children (`/admin/users`, `/admin/roles`,
`/admin/reserved-usernames`, `/admin/feature-flags`, `/admin/banners`,
`/admin/platform-integrations`, `/admin/provider-marks`, `/admin/codemods`,
`/admin/community-reports`, `/admin/insights`, `/admin/platform-feedback`,
`/admin/system-email`). `/admin/insights` shows launch MRR, paid mix, the
stamp-based activation funnel (overall and since 2026-09-10), active-user
windows, MCP client mix, entitlement ladders, open platform feedback, and
estimated Dynamic Worker cost vs catalog list pay, with a Risk panel for
catalog-paid accounts over list MRR, unpaid users at
≥$1 / 500 unique days
(50% of the $2 included-bucket alert), and Standard/Pro
rows whose `stripe_price_id` is missing or not in the catalog.
`/admin/users/:stableUserId` shows the same cost-vs-pay estimate for one
account.

## Drive it

```bash
node tools/control-kody.ts request GET /admin 403
```

403 on the seed account is success. Local `kody@example.com` is admin; do not
use it unless the change is an admin surface. The users list accepts
`verification=stalled` for unverified person accounts whose latest signup/verify
send is still `accepted` after 60 minutes. `/admin/users` can create a
pre-verified account and show a password-setup link. Operators run one bounded
unverified-account purge pass with `adminUnverifiedAccountPurgeRun` (`dryRun`
previews the next claim page; results carry stable user ids).

## APIs

JSON siblings under `/admin/*.json`. Same 403 for the preview seed.
