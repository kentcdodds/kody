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

Then drive the surface with `login`, `request`, `preview`, and `health`. See the
[control-kody skill](../../SKILL.md).

## Surfaces

- [login](./login.md) — `/login`
- [signup](./signup.md) — `/signup`
- [onboarding](./onboarding.md) — `/onboarding`
- [password-reset](./password-reset.md) — `/reset-password`
- [two-factor](./two-factor.md) — `/account/two-factor`
- [passkeys](./passkeys.md) — `/account/passkeys`
- [account](./account.md) — `/account`
- [packages](./packages.md) — `/account/packages`
- [secrets](./secrets.md) — `/account/secrets`
- [integrations](./integrations.md) — `/account/integrations`
- [mcp-servers](./mcp-servers.md) — `/account/mcp-servers`
- [jobs](./jobs.md) — `/account/jobs`
- [workflows](./workflows.md) — `/account/workflows`
- [activity](./activity.md) — `/account/activity`
- [waiting](./waiting.md) — `/account/waiting`
- [memories](./memories.md) — `/account/memories`
- [email](./email.md) — `/account/email`
- [values](./values.md) — `/account/values`
- [billing](./billing.md) — `/account/billing`
- [admin](./admin.md) — `/admin` (seed user is 403)
- [community](./community.md) — `/community`
- [marketing](./marketing.md) — `/`, `/guides`, `/blog`

## Seed users

| Environment | Email               | Password    | Notes                                        |
| ----------- | ------------------- | ----------- | -------------------------------------------- |
| Local       | `jane@example.com`  | `ilikecode` | Non-admin. Prefer this.                      |
| Local       | `kody@example.com`  | `ilikecode` | Admin. Avoid unless needed.                  |
| Preview     | `me@kentcdodds.com` | `ilikecode` | Non-admin. Empty until seeded via JSON APIs. |

Create preview data with `control-kody request` / `preview --request`. Do not
raw-D1-seed preview.
