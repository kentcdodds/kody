# Two-factor auth

TOTP setup and the `/verify` challenge after password login.

## How to get there

`/account/two-factor` while signed in. Challenge: `/verify`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/two-factor.json
```

## APIs

- `GET|POST /account/two-factor.json`
- `POST /verify/2fa.json`

## Gotchas

- SSR can paint before Remix binds click handlers. E2E waits on
  `html[data-hydrated]`. A screenshot of the form is not proof the submit works.
