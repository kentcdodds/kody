# Secret rotation

Procedures for rotating Worker secrets that protect session integrity and
saved-secret confidentiality.

## Key inventory

| Secret | Purpose | Impact of rotation |
| --- | --- | --- |
| `COOKIE_SECRET` | Signs auth session cookies (Remix `createCookie`) | Invalidates all active browser sessions; users must re-authenticate. |
| `SECRET_STORE_KEY` | Derives the AES-GCM KEK for saved secrets in D1 | Bricks all saved secrets encrypted under the old key unless a re-encryption migration runs. |

## Decoupling cookie and secret-store keys

Prior to this change, both session signing and saved-secret encryption derived
from `COOKIE_SECRET`. Rotating that single secret simultaneously logged out
every user **and** destroyed all encrypted secrets.

Now:

- **Cookie signing** uses `COOKIE_SECRET` only.
- **Saved-secret encryption** uses `SECRET_STORE_KEY` when set. There is no
  legacy decryption fallback anymore.

## Rotating `COOKIE_SECRET`

1. Deploy the new `COOKIE_SECRET` value.
2. All active browser sessions are invalidated (expected).
3. Saved secrets remain intact — they are encrypted under `SECRET_STORE_KEY`.

## Rotating `SECRET_STORE_KEY`

Rotating `SECRET_STORE_KEY` requires a re-encryption migration because AES-GCM
has no built-in key versioning.

### Procedure

1. **Keep the old key available** alongside the new key (for example, in a
   secure migration script or a temporary environment variable) so you can
   decrypt existing ciphertext.
2. **Decrypt all secrets with the old key** and re-encrypt them with the new
   `SECRET_STORE_KEY`. This can be done via a one-off script against D1 or a
   future `/__maintenance/reencrypt-secrets` endpoint.
3. **Deploy** the new `SECRET_STORE_KEY` only after the re-encryption pass is
   complete and verified.

### Important notes

- Never delete the old key value until re-encryption is verified complete.
- Monitor error rates after rotation; a spike in "Unable to decrypt secret
  value" errors indicates secrets were not re-encrypted with the new key.

## Generating secure key values

Use a cryptographically random string of at least 32 characters:

```sh
openssl rand -base64 48
```
