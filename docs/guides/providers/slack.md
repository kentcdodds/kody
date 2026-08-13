---
id: provider_slack
title: Connect Slack
summary:
  Verified walkthrough for connecting Slack to Kody via the built-in Slack OAuth
  integration, plus when to bring your own Slack app, reconnect links, and an
  auth.test smoke test.
category: provider
provider: Slack
lastVerified: 2026-08
---

# Connect Slack

Prefer the **built-in** Slack integration when it is enabled on the deployment.
Bring your own Slack app when you need a different bot/user token shape, custom
scopes, or a workspace-specific app registration the built-in cannot provide.

## What you get

Once connected, you can ask Kody things like:

- "List the public channels I can see in Slack."
- "Post this deploy summary to #eng-alerts."
- "Find recent messages mentioning the billing outage."

Exact capabilities depend on the scopes granted at connect time.

## Lane A: built-in Slack

List enabled built-ins with `integration_platform_app_list`. When `slack` is
enabled, connect with:

```text
https://kody.codes/connect/oauth?provider=slack
```

No Slack app dashboard setup for the common path. Token exchange uses the
operator-provisioned app; your tokens still land in your secret store. Confirm
the allowed/default scopes on the platform app before promising a workflow that
needs a rare permission.

## Lane B: bring-your-own Slack app

Use this when the built-in is unavailable or its scope menu cannot cover the
task. Create a Slack app, register the redirect URI
`https://kody.codes/connect/oauth`, choose the bot/user scopes you need, then
build a BYO `/connect/oauth` URL with Slack's authorize and token endpoints
(`https://slack.com/oauth/v2/authorize` and
`https://slack.com/api/oauth.v2.access`). See the [OAuth guide](../oauth.md) for
query parameters, confidential exchange, and reconnect behavior.

## Verify

Run this smoke test in `execute` after connecting (adjust the integration name
if you chose something other than `slack`):

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const slackFetch = await createAuthenticatedFetch('slack')
	const response = await slackFetch('https://slack.com/api/auth.test', {
		method: 'POST',
	})
	if (!response.ok) {
		throw new Error(
			`Slack smoke test HTTP failed: ${response.status} ${await response.text()}`,
		)
	}
	const data = (await response.json()) as {
		ok?: boolean
		error?: string
		user?: string
		team?: string
	}
	if (!data.ok) {
		throw new Error(`Slack auth.test failed: ${data.error ?? 'unknown'}`)
	}
	return { user: data.user, team: data.team }
}
```

## Troubleshooting

- Built-in connect still asks for a client ID: the `slack` platform app is
  disabled or missing — call `integration_platform_app_list`, or use Lane B.
- `invalid_auth` / `token_revoked`: reconnect with
  `/connect/oauth?provider=slack` (built-in) or your BYO connect URL.
- Missing channels or post failures: the granted scopes do not cover the API
  method. Widen scopes within the built-in menu or reconnect with a BYO app that
  includes them.
- `redirect_uri` mismatches on BYO: the registered redirect must be exactly
  `https://kody.codes/connect/oauth`.
