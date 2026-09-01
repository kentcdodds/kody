# Password reset

Forgot-password and signed-in password change.

## How to get there

Signed-out: `/reset-password`. Signed-in: account settings password form.

## Drive it

```bash
node tools/control-kody.ts request POST /account/password.json --body '{"currentPassword":"ilikecode","newPassword":"ilikecode"}'
```

Password `#1923` proved this with a preview video. GET the page after a change;
do not stop at "try this URL."

## APIs

- `POST /password-reset`
- `POST /password-reset/confirm`
- `POST /account/password.json`
