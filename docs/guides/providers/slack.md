---
id: provider_slack
title: Connect Slack
summary:
  Verified walkthrough for connecting Slack to Kody: create your own Slack
  app, register the redirect URI, reconnect links, and an auth.test smoke
  test.
category: provider
provider: Slack
lastVerified: 2026-08
---

# Connect Slack

Connect Slack by creating your own Slack app, registering Kody's redirect URI,
choosing the bot/user scopes you need, then finishing on `/connect/oauth`.

## What you get

Once connected, you can ask Kody things like:

- "List the public channels I can see in Slack."
- "Post this deploy summary to #eng-alerts."
- "Find recent messages mentioning the billing outage."

Exact capabilities depend on the scopes granted at connect time.

## Create a Slack app

Create a Slack app in the Slack API dashboard, register the redirect URI
`https://kody.codes/connect/oauth`, choose the bot/user scopes you need, then
build a `/connect/oauth` URL with Slack's authorize and token endpoints
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

- `invalid_auth` / `token_revoked`: reconnect with your `/connect/oauth` URL.
- Missing channels or post failures: the granted scopes do not cover the API
  method. Reconnect with a Slack app that includes them.
- `redirect_uri` mismatches: the registered redirect must be exactly
  `https://kody.codes/connect/oauth`.
