# Passkeys

WebAuthn registration and authentication.

## How to get there

`/account/passkeys`. Browser-gated; Cloud Agent VMs often lack a platform
authenticator.

## Drive it

```bash
node tools/control-kody.ts request GET /account/passkeys.json
```

HTTP can assert the empty list. Do not fail a ship because computerUse cannot
complete a WebAuthn ceremony.

## APIs

- `GET|POST /account/passkeys.json`
- `/webauthn/registration`
- `/webauthn/authentication`
