# Feature Map

Searchable map of Kody user-facing surfaces. Load one file, not this whole
directory.

The catalog in `tools/control-kody/feature-catalog.ts` is the machine-readable
source. `node tools/control-kody.ts map --check` fails when a listed path leaves
`routes.ts` or a required HTML route has no entry.

## How to use it

```bash
node tools/control-kody.ts map
node tools/control-kody.ts map waiting
node tools/control-kody.ts map --check
```

Then drive the surface with `login`, `request`, `preview`, and `health`. Run
`map --check` before opening a Feature Map PR. See the
[control-kody skill](../../SKILL.md).

## Surfaces

- [login](./login.md) — `/login`
- [signup](./signup.md) — `/signup`
- [onboarding](./onboarding.md) — `/onboarding`
- [password-reset](./password-reset.md) — `/reset-password`
- [two-factor](./two-factor.md) — `/account/two-factor`
- [passkeys](./passkeys.md) — `/account/passkeys`
- [account](./account.md) — `/account`
- [connections](./connections.md) — `/@<slug>/-/connections`
- [packages](./packages.md) — `/@username`
- [secrets](./secrets.md) — `/@<slug>/-/secrets`
- [integrations](./integrations.md) — `/@<slug>/-/integrations`
- [mcp-servers](./mcp-servers.md) — `/@<slug>/-/mcp-servers`
- [jobs](./jobs.md) — `/@<slug>/-/jobs`
- [workflows](./workflows.md) — `/@<slug>/-/workflows`
- [webhooks](./webhooks.md) — `/@username/kodyId/settings#webhooks` (index at
  `/@<slug>/-/webhooks`; generic `http` apply approval at
  `/connect/webhook-apply`)
- [activity](./activity.md) — `/@<slug>/-/activity`
- [waiting](./waiting.md) — `/@<slug>/-/waiting`
- [experiments](./experiments.md) — `/account/experiments`
- [memories](./memories.md) — `/@<slug>/-/memories`
- [email](./email.md) — `/@<slug>/-/email`
- [values](./values.md) — `/@<slug>/-/values`
- [billing](./billing.md) — `/@:orgSlug/-/billing`
- [admin](./admin.md) — `/admin` (seed user is 403)
- [community](./community.md) — `/community`
- [marketing](./marketing.md) — `/`, `/docs`, `/blog`, `/support`

## Seed users

| Environment | Email               | Password    | Notes                                        |
| ----------- | ------------------- | ----------- | -------------------------------------------- |
| Local       | `jane@example.com`  | `ilikecode` | Non-admin. Prefer this.                      |
| Local       | `kody@example.com`  | `ilikecode` | Admin. Avoid unless needed.                  |
| Preview     | `me@kentcdodds.com` | `ilikecode` | Non-admin. Empty until seeded via JSON APIs. |

Create preview data with `control-kody request` / `preview --request`. Do not
raw-D1-seed preview.
