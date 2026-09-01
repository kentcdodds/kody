---
id: provider_github
title: Connect GitHub
summary:
  Verified walkthrough for connecting GitHub to Kody: fine-grained personal
  access tokens, bring-your-own OAuth Apps, scope choices, prefilled connect
  links, and copy-paste smoke tests.
category: provider
provider: GitHub
lastVerified: 2026-08
---

# Connect GitHub

GitHub has two good lanes:

- **Personal access token** — fastest for many automations; saved as a Kody
  secret (and what `@kody/github` reads by default).
- **Bring-your-own OAuth App** — when you want a durable OAuth connection with
  your own client and rate limits.

## What you get

Once connected, you can ask Kody things like:

- "List my open pull requests and summarize the review comments."
- "Create an issue in my dotfiles repo about the flaky bootstrap script."
- "What merged in acme/api this week?"

## Before you start

- Personal accounts are free; no review process applies to these lanes.
- If you need repositories in an organization with OAuth App access
  restrictions, an org owner must approve the OAuth App before it can see org
  data. Fine-grained tokens have their own per-org approval flow for org-owned
  repositories.
- The API rate limit is 5,000 requests per hour per authenticated user.

## Lane A: personal access token (fastest for many automations)

1. Open
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
   and click **Generate new token** (fine-grained). Classic tokens at
   [github.com/settings/tokens](https://github.com/settings/tokens) also work
   but grant coarser access.
2. Name the token, set an expiration, choose **Only select repositories** (or
   all repositories), and pick the minimum repository permissions the task needs
   (for example **Contents: Read-only** and **Pull requests: Read-only** for
   reporting; add write permissions only for automation that mutates).
3. Generate the token and copy it once.

### Save the token in Kody

Save it through the account secrets page — never paste the token into chat:

```text
https://kody.codes/account/secrets/new?name=githubAccessToken&description=GitHub%20fine-grained%20personal%20access%20token&allowedHosts=api.github.com&scope=user
```

Approve the `api.github.com` host on the same page after saving. The name
`githubAccessToken` is exactly what the official `@kody/github` listing (and a
fork of it) reads by default, so no rename is needed.

## Lane B: bring-your-own OAuth App

1. Open [github.com/settings/developers](https://github.com/settings/developers)
   -> **OAuth Apps** -> **New OAuth App**.
2. Fill in the application name and homepage URL, and set the **Authorization
   callback URL** to `https://kody.codes/connect/oauth` (OAuth Apps accept one
   callback URL; a self-hosted deployment registers its own origin plus
   `/connect/oauth`).
3. After creating the app, click **Generate a new client secret** and copy the
   client ID and secret.

GitHub supports S256 PKCE and recommends it, but PKCE does not replace the
client secret — the secret is still required at the token endpoint, so the Kody
flow is `confidential`. OAuth App tokens have no scheduled expiry and there are
no refresh tokens, but GitHub revokes a token after a year without use; revoke
the grant from GitHub settings to kill one sooner.

### Connect to Kody

```text
https://kody.codes/connect/oauth?provider=github&authorizeUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Faccess_token&flow=confidential&scopes=read%3Auser%20notifications&allowedHosts=api.github.com
```

Decoded: authorize URL `https://github.com/login/oauth/authorize`, token URL
`https://github.com/login/oauth/access_token`, `flow=confidential`, scopes
`read:user notifications` (space-separated; adjust per the Scopes section), and
`allowedHosts=api.github.com`. Add `pkce=true` to layer S256 PKCE on top of the
confidential exchange. Paste the client ID and secret into the setup form, then
authorize.

## Verify

Lane A (saved secret) — run in `execute` after the host is approved:

```ts
export default async function main() {
	const response = await fetch('https://api.github.com/user', {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: 'Bearer {{secret:githubAccessToken}}',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	})
	if (!response.ok) {
		throw new Error(
			`GitHub smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const user = (await response.json()) as { login: string }
	return { login: user.login }
}
```

Lane B (OAuth integration):

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const githubFetch = await createAuthenticatedFetch('github')
	const response = await githubFetch('https://api.github.com/user', {
		headers: { Accept: 'application/vnd.github+json' },
	})
	if (!response.ok) {
		throw new Error(
			`GitHub smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const user = (await response.json()) as { login: string }
	return { login: user.login }
}
```

## Scopes

OAuth App scopes are space-delimited and coarse:

- Minimal read-mostly tier: `read:user`, `user:email`, `notifications`,
  `public_repo` (public repositories only), `read:org`.
- Fuller tier: `repo` grants full read/write on private repositories — there is
  no read-only scope for private repos, so requesting private access means
  accepting write access too. Add `gist` for gists.

Fine-grained tokens (Lane A) are the better tool when you want read-only access
to private repositories: their permissions are per-repository and
per-capability.

## Troubleshooting

- `The redirect_uri MUST match the registered callback URL`: the callback must
  be exactly `https://kody.codes/connect/oauth`.
- Organization repositories missing from results: the org restricts OAuth App
  access. Request approval under the org's third-party access settings, or use a
  fine-grained token approved for that org.
- `401 Bad credentials` with a saved token: the token expired or its value has a
  stray space. Rotate it at the token settings page and update the secret.
- `403` with `X-RateLimit-Remaining: 0`: the 5,000 req/hr per-user limit. Wait
  for the reset or batch queries with the GraphQL API.
- Token exchange fails in Lane B: the client secret is required even with PKCE.
  Regenerate the secret and reconnect.

## Use the official package and verify

A saved token or integration is credentials only. Finish by forking the official
helpers so day-to-day work goes through maintained code in **your** scope
instead of hand-rolled API calls.

1. Search for `@kody/github`. It wraps REST, GraphQL, pagination, and PR
   helpers.
2. `communityFork` it into your scope (or click **Install** on the listing).
3. Check the fork's README **Required setup**: the default `bot` account reads
   the `githubAccessToken` secret — the exact name Lane A saved, so no
   adaptation is needed for the PAT lane. For OAuth (Lane B), remap the account
   to the `github` integration name when the package supports that.
4. Verify the fork against your credentials from `execute`:

```ts
import getViewer from 'kody:@<your-username>/github/get-viewer'

export default async function main() {
	return getViewer({ account: 'bot' })
}
```

A successful response returns the GitHub login your token resolves to — proving
the fork, the secret, and the host approval all line up.
