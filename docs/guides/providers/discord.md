---
id: provider_discord
title: Connect Discord
summary:
  Verified walkthrough for connecting Discord to Kody: the OAuth user-token
  lane for identity and server membership, the bot-token lane required for
  reading or posting in servers, 7-day rotating tokens, prefilled connect
  links, and users/@me smoke tests for both lanes.
category: provider
provider: Discord
lastVerified: 2026-08
---

# Connect Discord

Discord apps are free and need no review for ordinary use. Which lane you need
depends entirely on the task, because Discord splits its API between user OAuth
tokens and bot tokens.

## What you get

Once connected, you can ask Kody things like:

- "Which Discord servers am I in?" (OAuth user token)
- "Post the daily standup summary to #general." (bot token)
- "Watch #support for questions mentioning billing." (bot token plus the Message
  Content intent)

## User OAuth token vs bot token

An OAuth user token cannot read server channel messages. OAuth scopes such as
`identify`, `email`, `guilds`, `connections`, and `guilds.members.read` cover
your identity, your server list, and your membership details — nothing inside
channels.

Reading or posting in servers requires a bot: create a bot user on your app's
**Bot** tab, install it into the server with an authorize URL that includes the
`bot` scope, and call the API with the bot token. Reading message content
additionally requires the privileged **Message Content** intent toggle on the
Bot tab.

Pick the lane before you start; many tasks need the bot lane even though the
OAuth lane is quicker to set up.

## Before you start

- You need a Discord account and the
  [developer portal](https://discord.com/developers/applications).
- OAuth access tokens expire after 7 days with rotating refresh tokens, so
  refresh must work from day one. Kody's `/connect/oauth` flow plus its token
  refresh (`createAuthenticatedFetch` / `refreshAccessToken`) handle that
  automatically.
- Installing a bot into a server requires the **Manage Server** permission in
  that server.

## Lane A: OAuth user token (identity and membership)

1. Open
   [discord.com/developers/applications](https://discord.com/developers/applications)
   and click **New Application**.
2. On the **OAuth2** tab, copy the **Client ID**, and reset/reveal the **Client
   Secret**.
3. Under **Redirects**, add `https://heykody.dev/connect/oauth` (a self-hosted
   deployment registers its own origin plus `/connect/oauth`).
4. Optional: enable the **Public Client** toggle to allow a secret-less PKCE
   exchange; otherwise the app is confidential.

### Connect to Kody

Confidential (default) shape:

```text
https://heykody.dev/connect/oauth?provider=discord&authorizeUrl=https%3A%2F%2Fdiscord.com%2Foauth2%2Fauthorize&tokenUrl=https%3A%2F%2Fdiscord.com%2Fapi%2Foauth2%2Ftoken&flow=confidential&scopes=identify%20guilds
```

Decoded: authorize URL `https://discord.com/oauth2/authorize`, token URL
`https://discord.com/api/oauth2/token`, `flow=confidential`, and scopes
`identify guilds` (space-separated). The token host `discord.com` doubles as the
API host, so no extra `allowedHosts` is needed. Discord's token endpoint accepts
only form-encoded bodies, which is Kody's default exchange style. If you enabled
**Public Client**, drop `flow=confidential` (PKCE is the default) and skip the
client secret. Paste the client credentials into the setup form, then authorize.

## Lane B: bot token (reading and posting in servers)

1. On your application's **Bot** tab, create the bot user and copy the bot token
   (reset it to reveal it).
2. If the bot must read message text, enable the **Message Content** intent on
   the same tab.
3. Install the bot into your server by opening an authorize URL with the `bot`
   scope and the permissions the bot needs, for example:
   `https://discord.com/oauth2/authorize?client_id=<your-client-id>&scope=bot&permissions=68608`
   (view channels, read history, send messages). Approve it in the server
   picker.

### Save the bot token in Kody

Save it through the account secrets page — never paste the token into chat:

```text
https://heykody.dev/account/secrets/new?name=discordBotToken&description=Discord%20bot%20token&allowedHosts=discord.com&scope=user
```

Approve the `discord.com` host on the same page after saving.

## Verify

Lane A (OAuth integration) — run in `execute` after connecting:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const discordFetch = await createAuthenticatedFetch('discord')
	const response = await discordFetch('https://discord.com/api/users/@me')
	if (!response.ok) {
		throw new Error(
			`Discord smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { username: string }
	return { username: me.username }
}
```

Lane B (bot token) — note the `Bot` prefix:

```ts
export default async function main() {
	const response = await fetch('https://discord.com/api/v10/users/@me', {
		headers: {
			Authorization: 'Bot {{secret:discordBotToken}}',
		},
	})
	if (!response.ok) {
		throw new Error(
			`Discord bot smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const bot = (await response.json()) as { username: string }
	return { username: bot.username }
}
```

## Scopes

OAuth scopes (Lane A), space-delimited:

- Minimal read-mostly tier: `identify` (username, avatar, id) and `guilds`
  (server list). This answers "who am I" and "where am I" without exposing email
  or per-server member data.
- Fuller tier: add `email`, `connections` (linked accounts), and
  `guilds.members.read` (your member profile per server). None of these read
  channel messages — that stays bot-only.

Bot capabilities (Lane B) are governed by the permissions integer in the install
URL, the bot's roles in each server, and privileged intents such as Message
Content — not by OAuth scopes.

## Troubleshooting

- `invalid_grant` or `invalid_request` on token exchange: the endpoint accepts
  only form-encoded bodies (Kody sends that by default), and each authorization
  code is single-use — restart the connect flow for a fresh code.
- OAuth calls failing after a week: access tokens expire in 7 days and refresh
  tokens rotate. `createAuthenticatedFetch` refreshes automatically; a raw
  cached token does not survive.
- `401 Unauthorized` with a bot token: check the `Bot ` prefix (OAuth tokens use
  `Bearer`, bot tokens use `Bot`), and confirm the token was not reset in the
  portal.
- Empty message content in bot events despite read access: enable the privileged
  **Message Content** intent on the Bot tab.
- `403 Missing Access` from a bot: the bot is not in that server or lacks
  channel permissions. Reinstall with the right permissions integer or fix its
  role.

## Go further

After the smoke test passes, run `community_search` for trusted Discord helper
packages (prefer trusted listings) — posting helpers and gateway/bot patterns
are common — or create a thin helpers package instead of repeating raw API calls
in `execute`.
