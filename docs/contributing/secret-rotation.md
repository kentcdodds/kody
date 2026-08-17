# Secret rotation

Procedures for rotating Worker secrets that protect session integrity and
saved-secret confidentiality.

## Key inventory

| Secret             | Purpose                                           | Impact of rotation                                                                          |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `COOKIE_SECRET`    | Signs auth session cookies (Remix `createCookie`) | Invalidates all active browser sessions; users must re-authenticate.                        |
| `SECRET_STORE_KEY` | Derives the AES-GCM KEK for saved secrets in D1   | Bricks all saved secrets encrypted under the old key unless a re-encryption migration runs. |

## Separate cookie and secret-store keys

Cookie signing and saved-secret encryption use separate Worker secrets:

- **Cookie signing** uses `COOKIE_SECRET` only.
- **Saved-secret encryption** requires `SECRET_STORE_KEY`. There is no legacy
  decryption fallback.

## Rotating `COOKIE_SECRET`

1. Deploy the new `COOKIE_SECRET` value.
2. All active browser sessions are invalidated (expected).
3. Saved secrets remain intact — they are encrypted under `SECRET_STORE_KEY`.

## Rotating `SECRET_STORE_KEY`

Rotating `SECRET_STORE_KEY` requires a re-encryption migration because AES-GCM
has no built-in key versioning.

### Escrow

The live key must remain recoverable outside GitHub Actions and the deployed
Worker. Solo escrow seals the key under an operator passphrase
(`SECRET_ESCROW_PASSPHRASE` in the password manager and as a GitHub secret) via
`.github/workflows/dr-escrow.yml`, which uploads
`escrow/secret-store-key.v1.json` to the DR backup bucket. The escrow object is
**write-once**: a second PUT to the same key is rejected, so re-sealing after a
rotation requires bumping `ESCROW_KEY_VERSION` (producing
`escrow/secret-store-key.v2.json`) when running
`tools/disaster-recovery/seal-escrow.ts`. The `dr-escrow.yml` workflow has no
version input today, so run the seal script locally with the new version (or add
the input) and then smoke-test unsealing offline. See
[Disaster recovery](./disaster-recovery.md).

### Procedure

1. **Keep the old key available** in a secure migration script so you can
   decrypt existing ciphertext while preparing the re-encryption pass.
2. **Decrypt all secrets with the old key** and re-encrypt them with the new
   `SECRET_STORE_KEY`. This is a key-rotation migration (old KEK plus new KEK),
   not the same-key format upgrade at `/__maintenance/reencrypt-secrets`. Use a
   one-off script against D1, or extend that maintenance endpoint to accept a
   previous key, before deploying the new `SECRET_STORE_KEY`.
3. **Re-seal escrow** for the new key value with a bumped `ESCROW_KEY_VERSION`
   (see Escrow above — the previous version's object is write-once) and
   smoke-test unsealing offline, so the new key is recoverable before it goes
   live.
4. **Deploy** the new `SECRET_STORE_KEY` only after the re-encryption pass and
   escrow verification are complete.

### Important notes

- Never delete the old key value until re-encryption is verified complete.
- Monitor error rates after rotation; a spike in "Unable to decrypt secret
  value" errors indicates secrets were not re-encrypted with the new key.

## Upgrading pre-AAD (2-part) ciphertexts

Encrypt helpers write `v2.<iv>.<ciphertext>` bound to an AAD identity context.
Rows that still store `<iv>.<ciphertext>` have no AAD. `decryptWithKey`
dual-reads both shapes; user-facing reads never rewrite. The operator pass
upgrades remaining 2-part rows in place without rotating `SECRET_STORE_KEY`.

`POST /__maintenance/reencrypt-secrets` (bearer `CAPABILITY_REINDEX_SECRET`):

1. Keyset-pages `secret_entries.encrypted_value`,
   `remote_connector_settings.encrypted_shared_secret`, and
   `platform_oauth_apps.client_secret_encrypted` where the payload is not
   `v2.%`.
2. Decrypts via the existing dual-read, re-encrypts as v2 with
   `userSecretContext(userId)` or `platformOauthAppContext(slug)`, and writes
   back with `WHERE … AND <column> = <old>` so a concurrent user rotation wins.
3. Counts decrypt failures and leaves those rows unchanged. The JSON result is
   counts plus stable row keys only — never ciphertext or plaintext.

Optional JSON body: `{ "dryRun": true }` to decrypt-verify without writes;
`{ "maxRows": 50 }` to bound one invocation (default 500). Repeat until every
table reports `remaining: 0`. `remaining` is the scan-set leftover (including
rows that failed decryption and stay 2-part). If `remaining` stalls and
`decryptFailures` is non-empty after a run that did not hit the row budget,
inspect those keys instead of looping. This is a production mutation; run it
only after an explicit operator go-ahead.

## Generating secure key values

Use a cryptographically random string of at least 32 characters:

```sh
openssl rand -base64 48
```
