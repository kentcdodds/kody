# OAuth guide (standard path)

**Read this guide first** for third-party OAuth (connect a user’s GitHub,
Linear, Spotify, etc. to Kody). The default pattern is Kody’s **hosted
connector**, not custom generated UI.

If the OAuth connection will power a downstream skill or app, load
`kody_official_guide` with `guide: "integration_bootstrap"` before building that
artifact. This guide covers the OAuth mechanics only.

## Default: `/connect/oauth`

Send the signed-in user to **`/connect/oauth`** on your deployment host with
query parameters that describe the provider. The page runs **authorize →
callback → token exchange** in a full browser context and persists access and
refresh tokens (and related values) via the account secrets API—**no**
\`open_generated_ui\`, \`ui_save_app\`, or \`kodyWidget\` OAuth code required.

Example shape (encode values for real URLs):

\`\`\`text
https://heykody.dev/connect/oauth?provider=…&authorizeUrl=…&tokenUrl=…&… \`\`\`

### Redirect URI

In the provider’s developer console, register the redirect URI as:

\`\`\`text {origin}/connect/oauth \`\`\`

Use the same origin the user uses to open Kody (callback lands on that path with
\`code\` and \`state\` query params).

### Required query parameters

| Param            | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| \`provider\`     | Short label for the integration (letters/digits; drives stored value/secret names). |
| \`authorizeUrl\` | Provider authorization endpoint URL.                                                |
| \`tokenUrl\`     | Provider token endpoint URL.                                                        |

The token endpoint’s host is always included for host approval; add more with
\`allowedHosts\` if the API calls other origins.

### Common optional parameters

| Param                         | Purpose                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| \`flow\`                      | \`pkce\` (default) or \`confidential\` (client secret on token exchange). |
| \`scopes\`                    | Space- or separator-separated scopes (see \`scopeSeparator\`).            |
| \`scopeSeparator\`            | Defaults to a single space.                                               |
| \`allowedHosts\`              | Comma-separated extra API hosts beyond the token host.                    |
| \`apiBaseUrl\`                | Optional API base URL hint for documentation/UX.                          |
| \`dashboardUrl\`              | Link to the provider’s app or key settings.                               |
| \`extraAuthorizeParams\`      | Provider-specific authorize query params (encoding rules in the UI).      |
| \`providerSetupInstructions\` | Free-form setup hints shown in the wizard.                                |

Client ID, access token, and refresh token **names** are derived from a
normalized slug of \`provider\` (see
\`packages/worker/client/routes/connect-oauth.tsx\`).

### Not the same as MCP OAuth

Do **not** confuse **`/connect/oauth`** with Kody’s **MCP OAuth** endpoints
(\`/oauth/authorize\`, \`/oauth/callback\`, etc.). Those are for **clients
authenticating to Kody**. This guide is for **outbound** provider OAuth.

## If this path is not enough

| Need                                                                  | Use                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| API keys or PATs (paste-free), not OAuth                              | \`kody_official_guide\` with \`guide: "connect_secret"\` (\`/connect/secret\`).                                         |
| Custom UX, branding, or callback on a **saved app** URL (\`/ui/:id\`) | \`kody_official_guide\` with \`guide: "generated_ui_oauth"\` — see [Generated UI OAuth guide](./generated-ui-oauth.md). |

## Agent checklist (standard OAuth)

1. Confirm OAuth is appropriate (vs static secret → \`connect_secret\`).
2. Build the \`/connect/oauth\` URL with required params and any optional
   fields.
3. Tell the user the exact **redirect URI** to register:
   \`{origin}/connect/oauth\`.
4. Have the user open the connect URL while signed in; wait for success.
5. If the OAuth connection will back a saved skill or app, verify connector
   state and run the authenticated smoke test described in
   `guide: "integration_bootstrap"` before saving the downstream artifact.
6. Continue with capabilities that use \`{{secret:…}}\` or connector helpers;
   host/capability approval may still be required after save.

## Example: Spotify-backed saved app after auth bootstrap

Use this pattern only **after** the hosted `/connect/oauth` flow is complete,
the Spotify connector already exists, and the authenticated smoke test passes.

The ordering is:

1. auth bootstrap first
2. smoke test second
3. save the app with `serverCode` backend routes
4. keep `clientCode` mostly UI plus fetches to `kodyWidget.appBackend.basePath`

For non-trivial apps, keep provider API calls in `serverCode`, not in embedded
client-side `executeCode(...)` strings. Those inline snippets are acceptable for
quick or throwaway prototypes only.

```ts
await codemode.ui_save_app({
	title: 'Spotify playback controls',
	description:
		'Read current playback state and trigger simple Spotify actions through a saved app backend.',
	clientCode: `
		<main>
			<h1>Spotify playback controls</h1>
			<p id="track">Loading...</p>
			<div style="display:flex;gap:0.5rem;">
				<button type="button" data-action="refresh">Refresh</button>
				<button type="button" data-action="next">Next track</button>
				<button type="button" data-action="pause">Pause</button>
			</div>
			<script type="module">
				import { kodyWidget } from '@kody/ui-utils'

				const track = document.querySelector('#track')
				const basePath = kodyWidget.appBackend?.basePath
				function requireBackendBasePath() {
					if (!basePath) {
						track.textContent = 'Saved app backend is not available.'
						return null
					}
					return basePath
				}

				async function loadState() {
					const resolvedBasePath = requireBackendBasePath()
					if (!resolvedBasePath) return
					const response = await fetch(\`\${resolvedBasePath}/api/state\`)
					const payload = await response.json()
					track.textContent = payload.trackName
						? \`\${payload.trackName} — \${payload.artistName}\`
						: 'Nothing is currently playing.'
				}

				async function runAction(action) {
					const resolvedBasePath = requireBackendBasePath()
					if (!resolvedBasePath) return
					await fetch(\`\${resolvedBasePath}/api/action\`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action }),
					})
					await loadState()
				}

				document.querySelectorAll('[data-action]').forEach((button) => {
					button.addEventListener('click', () => {
						const action = button.getAttribute('data-action')
						if (action === 'refresh') {
							void loadState()
							return
						}
						if (action) void runAction(action)
					})
				})

				void loadState()
			</script>
		</main>
	`,
	serverCode: `
		import { DurableObject } from 'cloudflare:workers'

		export class App extends DurableObject {
			async spotifyRequest(path, init = {}) {
				const { connector } = await this.env.KODY.connectorGet({ name: 'spotify' })
				if (!connector?.apiBaseUrl) {
					return new Response('Missing spotify connector.', { status: 400 })
				}

				const authorization = await this.env.KODY.secretPlaceholder(
					connector.accessTokenSecretName,
					'user',
				)
				const upstream = await this.env.KODY.fetchWithResolvedSecrets({
					url: new URL(path, connector.apiBaseUrl).toString(),
					method: init.method ?? 'GET',
					headers: {
						authorization: \`Bearer \${authorization}\`,
						...(init.body ? { 'content-type': 'application/json' } : {}),
					},
					body: init.body,
				})

				return await fetch(upstream.url, {
					method: upstream.method,
					headers: upstream.headers,
					body: upstream.body,
				})
			}

			async fetch(request) {
				const url = new URL(request.url)

				if (url.pathname === '/api/state' && request.method === 'GET') {
					const response = await this.spotifyRequest('/me/player/currently-playing')
					const payload = response.ok ? await response.json().catch(() => null) : null
					return Response.json({
						trackName: payload?.item?.name ?? null,
						artistName: payload?.item?.artists?.[0]?.name ?? null,
					})
				}

				if (url.pathname === '/api/action' && request.method === 'POST') {
					const body = await request.json().catch(() => null)
					const path =
						body?.action === 'next'
							? '/me/player/next'
							: body?.action === 'pause'
								? '/me/player/pause'
								: null
					if (!path) return new Response('Unsupported action.', { status: 400 })
					try {
						const response = await this.spotifyRequest(path, { method: 'POST' })
						if (!response.ok) {
							const details = await response.text().catch(() => '')
							return new Response(
								details || 'Spotify action request failed.',
								{ status: response.status || 502 },
							)
						}
						return Response.json({ ok: true })
					} catch (error) {
						return new Response(
							error instanceof Error
								? error.message
								: 'Spotify action request failed.',
							{ status: 502 },
						)
					}
				}

				return new Response('Not found.', { status: 404 })
			}
		}
	`,
	hidden: false,
})
```
