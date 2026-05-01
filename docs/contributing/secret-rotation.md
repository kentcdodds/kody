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
- **Saved-secret encryption** uses `SECRET_STORE_KEY` when set, falling back to
  `COOKIE_SECRET` for backward compatibility with existing ciphertext.

## Rotating `COOKIE_SECRET`

1. Deploy the new `COOKIE_SECRET` value.
2. All active browser sessions are invalidated (expected).
3. Saved secrets remain intact — they are encrypted under `SECRET_STORE_KEY`
   (or legacy `COOKIE_SECRET`-derived key with automatic fallback).

## Rotating `SECRET_STORE_KEY`

Rotating `SECRET_STORE_KEY` requires a re-encryption migration because AES-GCM
has no built-in key versioning.

### Procedure

1. **Keep the old key available** — set `COOKIE_SECRET` to the **old**
   `SECRET_STORE_KEY` value temporarily (or use a dedicated migration env var in
   a future iteration). The runtime's legacy-fallback path will use
   `COOKIE_SECRET` to decrypt old ciphertext.
2. **Deploy** with the new `SECRET_STORE_KEY` and the adjusted `COOKIE_SECRET`.
3. **Trigger a full read pass** over all secrets so the fallback path decrypts
   with the old key and transparently re-encrypts under the new key. A future
   `/__maintenance/reencrypt-secrets` endpoint can automate this; until then,
   iterating through all secret entries via a one-off script against D1 achieves
   the same effect.
4. Once all rows are re-encrypted, **restore `COOKIE_SECRET`** to its normal
   session-signing value.

### Important notes

- Never delete the old key value until re-encryption is verified complete.
- The fallback decrypt path only fires when primary decryption fails — it does
  not add latency to normal reads.
- Monitor error rates after rotation; a spike in "Unable to decrypt secret
  value" errors indicates the fallback key is also wrong.

## Generating secure key values

Use a cryptographically random string of at least 32 characters:

```sh
openssl rand -base64 48
```
