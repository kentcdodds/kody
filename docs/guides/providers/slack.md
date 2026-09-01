---
id: provider_slack
title: Connect Slack
summary:
  Verified walkthrough for connecting Slack to Kody with a user-token Slack app,
  then calling it from `@kody/slack`.
category: provider
provider: Slack
lastVerified: 2026-08
---

# Connect Slack

`@kody/slack` talks Slack with a **user token**. Create your own Slack app with
**User Token Scopes**, register Kody's redirect URI, then finish on
`/connect/oauth`. The helpers reject bot-only grants (`xoxb-` / `auth.test` with
`bot_id` and no `user_id`).

## What you get

Once connected, you can ask Kody things like:

- "List the public channels I can see in Slack."
- "Post this deploy summary to #eng-alerts."
- "Find recent messages mentioning the billing outage."

Exact capabilities depend on the User Token Scopes granted at connect time.

## Create a user-token Slack app

1. Confirm there is no existing **user-token** Slack connection:
   `integrationList`. A connection named `slack` that only has a bot grant does
   not count — leave it and use a distinct name such as `slack-user`.
2. Create a Slack app at <https://api.slack.com/apps> with **User Token
   Scopes**. User-token Slack uses `oauth/v2_user` + `oauth.v2.user.access`, not
   the bot-token `oauth/v2` + `oauth.v2.access`.
3. Register the redirect URI `https://kody.codes/connect/oauth`.
4. Ask the user for the **client id**. They paste the **client secret** on
   `/connect/oauth` — never in chat.
5. Open `/connect/oauth` (or `/connect/oauth?provider=slack-user` when `slack`
   is already a bot grant). Fill:
   - **Name:** `slack` when free, otherwise a distinct name
   - **Authorization URL:** `https://slack.com/oauth/v2/authorize`
   - **Token URL:** `https://slack.com/api/oauth.v2.user.access`
   - **Client ID:** the Slack app client id
   - **Client secret:** paste on the form
   - **Scopes:** comma-separated User Token Scopes
   - **PKCE:** off (confidential client)
   - **Allowed hosts:** `slack.com,files.slack.com`
6. After they authorize, `./smoke-test` on `@kody/slack` (or the forked package)
   must report a user identity. A bot token is a failed setup, not a package
   bug.

See the [OAuth guide](../oauth.md) for query parameters, confidential exchange,
and reconnect behavior.

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
		user_id?: string
		bot_id?: string
		team?: string
	}
	if (!data.ok) {
		throw new Error(`Slack auth.test failed: ${data.error ?? 'unknown'}`)
	}
	if (!data.user_id || data.bot_id) {
		throw new Error(
			'Slack auth.test returned a bot grant. @kody/slack needs a user token.',
		)
	}
	return { user: data.user, userId: data.user_id, team: data.team }
}
```

After the connection exists, call Slack through
`createAuthenticatedFetch('slack')` (or the connection name you chose). Do not
store Slack OAuth tokens as named secrets.

## Troubleshooting

- `invalid_auth` / `token_revoked`: reconnect with your `/connect/oauth` URL.
- Missing channels or post failures: the granted User Token Scopes do not cover
  the API method. Reconnect with a Slack app that includes them.
- `redirect_uri` mismatches: the registered redirect must be exactly
  `https://kody.codes/connect/oauth`.
- `auth.test` shows `bot_id` and no `user_id`: this is a bot token. Do not retry
  `@kody/slack` helpers. Connect a user-token Slack app instead (use a distinct
  name such as `slack-user` if `slack` is already the bot connection).

## Do not

- Do not send the user to `/account/secrets/new` for Slack OAuth tokens.
- Do not `secretSet` Slack access or refresh tokens.
- Do not paste tokens or the Slack client secret in chat.
- Do not treat a bot-token Slack connection as a working `@kody/slack` setup.
- Do not invent `xoxp-` / `xoxb-` token collection outside `/connect/oauth`.
