# Sign up and email verify

Create an account, then confirm email.

## How to get there

`/signup` → verification email → `/verify-email` or `/pending-verification`.
Email-change confirm is `/verify-email-change` (token from the change email).
Former-address release confirm is `/verify-email-claim-release`.

## Drive it

Prefer the seeded login. Creating accounts in preview is rarely needed.

```bash
node tools/control-kody.ts request GET /signup --origin http://localhost:3742 --skip-login
```

## APIs

- `POST /auth` `{ mode: "signup", ... }`
- `POST /account/resend-verification.json`

## Gotchas

- Preview seed is already verified. Do not invent a second user unless the
  change is the signup path itself.
- Signup copy: "By creating an account you agree to the Terms of Service and
  acknowledge the Privacy Policy" (`/terms`, `/privacy`).
- Signup gating is `invite` / `open` / `waitlist` from `/admin/invites`
  (`SIGNUP_MODE` is the default when no override is set). Production defaults to
  invite.
- Person accounts that stay unverified for seven days are deleted.
