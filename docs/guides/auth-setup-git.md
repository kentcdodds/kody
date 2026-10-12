---
id: auth_setup_git
title: Git credential helper contract (setup-git)
summary:
  Server contract for `kody auth setup-git`: user-owned CLI tokens, `?org=`,
  `POST /v1/git/credentials`, and authenticated clone of
  `https://kody.codes/@owner/name.git`.
category: platform
---

# Git credential helper contract (`kody auth setup-git`)

This page is the **server contract** for the CLI `kody auth setup-git` command
(implemented in `kody-bot/cli`). Clone and fetch only; push and SSH are out of
scope.

## Version detection

| Signal                                                                               | Meaning                     |
| ------------------------------------------------------------------------------------ | --------------------------- |
| `GET https://api.kody.codes/openapi.json` includes `operationId` `gitCredentialMint` | Mint endpoint is live       |
| Token metadata includes `org_binding` (`org` \| `user`)                              | User-owned tokens are live  |
| New `cliCredentialBootstrap` redeems yield `org_binding: "user"`                     | CLI tokens are person-owned |

If `gitCredentialMint` is absent, the CLI must not install the helper against
this origin (older deploy).

## User-owned API tokens

### Behavior

| Token                                    | Org on each request                              | Leaving an org                                                  |
| ---------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `org_binding: "org"` (legacy / explicit) | Fixed `org_id` on the token row. Ignore `?org=`. | Org-bound tokens for that org are revoked on leave (unchanged). |
| `org_binding: "user"` (new CLI default)  | `?org=<slug-or-id>`; omit → personal org.        | Token stays; membership/grant checks deny immediately.          |

The same `kody_at_…` token covers Open API, CapabilityProxy / local execute, and
git credential minting. Scopes still narrow every call.

### Request org selection

- **HTTP Open API / CapabilityProxy:** query parameter `?org=<slug>` (or org
  id). Do **not** send `X-Kody-Org` — the API edge does not forward custom
  headers.
- **Default:** personal org (person `stable_user_id`).
- **Errors:** inaccessible or unknown `org` → `401 unauthorized` with a message
  that names `?org=`.

### Minting

- **New `cliCredentialBootstrap` / redeem:** mints `org_binding: "user"` by
  default. Outstanding bootstrap codes created before this change still redeem
  as `org` (additive; no forced cutover).
- **`tokenCreate`:** defaults to `org` (current request org). Pass
  `"org_binding": "user"` for a person-owned token. An org-bound parent token
  cannot mint a user-owned child.

Existing org-bound tokens keep working unchanged.

## Git credential mint

### Endpoint

```
POST /v1/git/credentials
Authorization: Bearer <kody_at_…>
Content-Type: application/json
```

Optional: `?org=<slug>` when using a user-owned token (defaults to personal).
Mint authz for the target repo uses the **resource owner's** org membership or
grant, not only the selected `?org=`.

### Request (git credential protocol fields)

```json
{
	"host": "kody.codes",
	"path": "/@owner/name.git",
	"protocol": "https"
}
```

| Field      | Rules                                                        |
| ---------- | ------------------------------------------------------------ |
| `host`     | Must equal the app origin host (production: `kody.codes`)    |
| `path`     | `/@owner/name.git` (leading slash optional; `.git` required) |
| `protocol` | Optional; only `https`                                       |

### Response `200`

```json
{
	"protocol": "https",
	"host": "kody.codes",
	"path": "/@owner/name.git",
	"username": "x",
	"password": "kody_gt_<id>_<secret>",
	"expires_at": "2026-10-12T20:00:00.000Z",
	"resource_kind": "package",
	"owner_handle": "owner",
	"repo_name": "name"
}
```

CLI credential helper output for git:

```
username=x
password=kody_gt_…
```

Do **not** store the password in git's `store` helper. Lifetime is ~1 hour
(absolute; not sliding).

### Errors

| Status | Code              | When                                                                  |
| ------ | ----------------- | --------------------------------------------------------------------- |
| `400`  | `invalid_request` | Bad host/path/protocol                                                |
| `401`  | `unauthorized`    | Missing/invalid/expired API token, or `?org=` not accessible          |
| `404`  | `not_found`       | No readable package/repo at that path (or token lacks `package:read`) |
| `403`  | (surface)         | Reserved; mint uses handler checks instead of a surface org gate      |

### Authz

Caller must:

1. Hold `package:read` on the API token scopes.
2. Be able to read the target (org membership or live grant with `package:read`
   on a package; org-level `package:read` for a plain repo).

Name collision: if both a package and a plain repo exist under the same
`@owner/name`, a readable **package** wins.

## Authenticated git HTTP

Canonical URL (unchanged shape):

```text
https://kody.codes/@owner/name.git
```

| Client                                                        | Behavior                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Anonymous + public listed package                             | Unchanged: published snapshot, read-only upload-pack                        |
| Anonymous + private / missing                                 | `401` + `WWW-Authenticate: Basic realm="kody-git"` (so git asks the helper) |
| Basic/Bearer `kody_gt_…` scoped to this path + still readable | Live HEAD upload-pack for that package or plain repo                        |
| Valid token, wrong repo or lost access                        | `404`                                                                       |
| Invalid token                                                 | `401`                                                                       |
| `git-receive-pack` / push                                     | `403` (always)                                                              |

Git config installed by `kody auth setup-git` (CLI side):

```bash
git config --global credential.https://kody.codes.helper '!kody git-credential'
# ensure path is sent:
git config --global credential.https://kody.codes.useHttpPath true
```

## Out of scope (this contract)

- Push / receive-pack
- SSH
- Changing public anonymous snapshot semantics
- Forced migration of existing org-bound `kody_at_…` tokens
