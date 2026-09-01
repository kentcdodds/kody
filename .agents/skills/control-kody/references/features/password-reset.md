# Password reset

Forgot-password and signed-in password change.

## How to get there

Signed-out: `/reset-password`. Signed-in: account settings password form.

## Drive it

Do not POST a new password that matches the shared seed (`ilikecode`) — that
does not prove the change. Prefer GET the form. If you must mutate, use a
distinct temporary password and restore `ilikecode` afterward.

```bash
node tools/control-kody.ts request GET /account
node tools/control-kody.ts request GET /reset-password --skip-login
```

Password `#1923` proved the signed-in change with a preview video. GET the page
after a change; do not stop at "try this URL."

## APIs

- `POST /password-reset`
- `POST /password-reset/confirm`
- `POST /account/password.json`
