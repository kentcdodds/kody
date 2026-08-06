---
id: provider_spotify
title: Connect Spotify
summary:
  Verified walkthrough for connecting Spotify to Kody: dashboard app
  creation, the Development Mode Premium requirement and endpoint limits in
  force since February 2026, the PKCE public-client connect link, listening
  and playback scopes, and a profile smoke test.
category: provider
provider: Spotify
lastVerified: 2026-08
---

# Connect Spotify

Spotify uses a personal app created in its developer dashboard, connected to
Kody with the authorization code + PKCE flow. PKCE is a public-client flow, so
no client secret needs to be stored.

## What you get

Once connected, you can ask Kody things like:

- "What did I listen to this morning?"
- "Add the current track to my liked songs playlist."
- "Build a report of my top artists this month."

## Before you start

Read the costs section first — Spotify's Development Mode has real
prerequisites.

### Costs and limits

- Since February 2026, Development Mode requires the app owner to hold Spotify
  Premium. If Premium lapses, the app stops working until it is restored.
- New developers can create up to 25 client IDs.
- Some Web API endpoints are unavailable in Development Mode; see the
  [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
  for the endpoint list.
- Extended Quota Mode is only available to organizations with at least 250k
  monthly active users — not a realistic path for individuals. Personal use
  stays in Development Mode, which is fine for one user: the app owner can
  always authorize their own app.

## Create the app

1. Open the
   [Spotify developer dashboard](https://developer.spotify.com/dashboard) and
   click **Create app**.
2. Fill in the app name and description, set the redirect URI to
   `https://heykody.dev/connect/oauth`, select **Web API** under the APIs used,
   and accept the developer terms. Spotify requires HTTPS redirect URIs and does
   not accept `localhost`, so use the hosted Kody URI (a self-hosted deployment
   registers its own HTTPS origin plus `/connect/oauth`). Matching is exact.
3. Copy the **client ID** from the app page. With PKCE you do not need the
   client secret (it lives under **Settings** if you ever choose the
   confidential flow instead).
4. Only if someone other than the app owner will authorize: add their Spotify
   account under **User Management** (Development Mode allows up to 5 users).
   For personal use this step is unnecessary.

## Connect to Kody

`flow=pkce` is Kody's default, so the link needs no flow parameter and no client
secret:

```text
https://heykody.dev/connect/oauth?provider=spotify&authorizeUrl=https%3A%2F%2Faccounts.spotify.com%2Fauthorize&tokenUrl=https%3A%2F%2Faccounts.spotify.com%2Fapi%2Ftoken&scopes=user-read-recently-played%20user-read-playback-state%20user-library-read&allowedHosts=api.spotify.com
```

Decoded: authorize URL `https://accounts.spotify.com/authorize`, token URL
`https://accounts.spotify.com/api/token`, scopes
`user-read-recently-played user-read-playback-state user-library-read`
(space-separated; adjust per the Scopes section), and
`allowedHosts=api.spotify.com`. Paste the client ID into the setup form, then
authorize.

Access tokens last one hour, and PKCE refresh tokens rotate on every use. Kody's
token refresh handles both automatically.

## Verify

Run this smoke test in `execute` after connecting:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const spotifyFetch = await createAuthenticatedFetch('spotify')
	const response = await spotifyFetch('https://api.spotify.com/v1/me')
	if (!response.ok) {
		throw new Error(
			`Spotify smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { display_name?: string; id: string }
	return { id: me.id, displayName: me.display_name }
}
```

## Scopes

Space-delimited. Start with the read tier:

- Minimal read-mostly tier: `user-read-recently-played`,
  `user-read-playback-state`, `user-read-currently-playing`,
  `user-library-read`, `playlist-read-private`, `user-top-read`. These cover
  listening history, current playback, saved tracks, private playlists, and top
  artists/tracks.
- Fuller tier: add `user-modify-playback-state` to control playback (play,
  pause, skip, queue). Playback control acts on your real devices, so only add
  it when you actually want Kody driving the speakers.

Changing scopes means reconnecting: `/connect/oauth?provider=spotify` with a new
`scopes` value re-runs consent.

## Troubleshooting

- `INVALID_CLIENT: Invalid redirect URI`: the dashboard redirect URI must be
  exactly `https://heykody.dev/connect/oauth`. Spotify rejects `localhost` and
  any non-HTTPS URI.
- `403 User not registered in the Developer Dashboard`: someone other than the
  app owner tried to authorize a Development Mode app. Add them under **User
  Management** (max 5) or have them create their own app.
- `403` on a specific endpoint that works elsewhere: that endpoint may be
  unavailable in Development Mode; check the February 2026 migration guide.
- App suddenly failing across the board: check that the app owner's Premium
  subscription is active — Development Mode requires it.
- `401` after roughly an hour in a long-running script: access tokens expire
  hourly. Use `createAuthenticatedFetch`, which refreshes automatically, instead
  of caching a raw token.

## Go further

After the smoke test passes, run `community_search` for trusted Spotify helper
packages (prefer trusted listings) — playback and library helpers are common —
or create a thin helpers package rather than repeating raw Web API calls in
`execute`.
