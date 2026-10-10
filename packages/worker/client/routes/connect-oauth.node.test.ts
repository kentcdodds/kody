import { utf8ToBase64Url } from '@kody-internal/shared/base64.ts'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import {
	type ConnectOauthQueryConfig,
	createCodeChallenge,
	createCodeVerifier,
	decodeBase64Payload,
	formatConnectOauthCaughtError,
	formatOAuthExchangeFailure,
	isBrowserFetchNetworkError,
	isMostlyPrintable,
	isOAuthExchangeSessionExpired,
	isSafeExternalUrl,
	mergeConnectOauthConfig,
	parseConnectOauthNextSteps,
	parseExtraParams,
	parseOptionalUrl,
	parseProviderSetupInstructions,
	parseScopes,
	parseSessionConnectOauthConfig,
	parseStoredIntegrationConfig,
	type StoredIntegrationConfig,
	summarizeStoredSetupState,
} from './connect-oauth-config.ts'
import { renderSuccessCard } from './connect-oauth-forms.tsx'
import { connectOauthConnectionHref } from './connect-oauth.tsx'

function makeQuery(
	provider: string,
	overrides: Partial<ConnectOauthQueryConfig> = {},
): ConnectOauthQueryConfig {
	return {
		provider,
		providerKey: provider,
		authorizeHost: null,
		authorizeUrl: null,
		tokenUrl: null,
		apiBaseUrl: null,
		scopes: null,
		flow: null,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: null,
		providerSetupInstructions: null,
		dashboardUrl: null,
		allowedHosts: [],
		...overrides,
	}
}

function merge(
	queryConfig: ConnectOauthQueryConfig,
	storedIntegration: StoredIntegrationConfig | null = null,
) {
	return mergeConnectOauthConfig({ queryConfig, storedIntegration })
}

const spotifyQuery = makeQuery('spotify', {
	authorizeHost: 'accounts.spotify.com',
	authorizeUrl: 'https://accounts.spotify.com/authorize',
	tokenUrl: 'https://accounts.spotify.com/api/token',
	scopes: [],
	flow: 'pkce',
	scopeSeparator: ' ',
	extraAuthorizeParams: {},
	allowedHosts: ['accounts.spotify.com'],
})

const googleYoutubeStored = (
	scopes: Array<string>,
): StoredIntegrationConfig => ({
	name: 'google-youtube-brand',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com/youtube/v3',
	flow: 'confidential',
	clientId: 'google-youtube-brand-client-id-value',
	hasClientSecret: true,
	requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes,
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
	},
})

test('connect OAuth helpers parse stored integrations, merge reconnect configs, and derive provider defaults', () => {
	expect(
		parseStoredIntegrationConfig(
			JSON.stringify({
				name: 'GitHub',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com/',
				flow: 'confidential',
				clientId: 'github-client-id-value',
				hasClientSecret: true,
				requiredHosts: ['api.github.com', ' github.com ', 'api.github.com'],
				authorization: {
					authorizeUrl: 'ftp://github.com/login/oauth/authorize',
					scopes: ['repo', 'read:user'],
					scopeSeparator: null,
					extraAuthorizeParams: { prompt: 'consent' },
				},
			}),
			null,
		),
	).toEqual({
		name: 'GitHub',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com/',
		flow: 'confidential',
		usePkce: null,
		clientId: 'github-client-id-value',
		hasClientSecret: true,
		requiredHosts: ['api.github.com', 'github.com'],
		authorization: null,
	})

	const githubConfig = merge(
		makeQuery('github', {
			authorizeHost: 'github.com',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo', 'read:user'],
			scopeSeparator: ' ',
			extraAuthorizeParams: { prompt: 'consent' },
			providerSetupInstructions: 'Open the GitHub app settings.',
			dashboardUrl: 'https://github.com/settings/developers',
			allowedHosts: ['github.com'],
		}),
		{
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientId: 'github-client-id-value',
			hasClientSecret: true,
			requiredHosts: ['api.github.com'],
		},
	)
	expect(githubConfig).toMatchObject({
		provider: 'GitHub',
		providerKey: 'github',
		authorizeHost: 'github.com',
		tokenHost: 'github.com',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		scopes: ['repo', 'read:user'],
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'form',
		scopeSeparator: ' ',
		extraAuthorizeParams: { prompt: 'consent' },
		dashboardUrl: 'https://github.com/settings/developers',
		clientId: 'github-client-id-value',
		hasClientSecret: true,
		allowedHosts: ['api.github.com', 'github.com'],
	})

	const youtubeScopes = [
		'https://www.googleapis.com/auth/youtube',
		'https://www.googleapis.com/auth/youtube.force-ssl',
	]
	expect(
		merge(
			makeQuery('google-youtube-brand'),
			googleYoutubeStored(youtubeScopes),
		),
	).toMatchObject({
		provider: 'google-youtube-brand',
		authorizeHost: 'accounts.google.com',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		scopes: youtubeScopes,
		scopeSeparator: ' ',
		extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
		allowedHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
	})

	// Empty query scopes/params fall back to the stored authorization.
	expect(
		merge(
			makeQuery('google-youtube-brand', {
				scopes: [],
				extraAuthorizeParams: {},
			}),
			googleYoutubeStored([
				'https://www.googleapis.com/auth/youtube.force-ssl',
			]),
		),
	).toMatchObject({
		scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
		extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
		platformAllowedScopes: [],
	})

	expect(
		merge(makeQuery('google'), {
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'confidential',
			clientId: 'platform-google-client',
			hasClientSecret: false,
			requiredHosts: ['oauth2.googleapis.com'],
			platformAppSlug: 'google',
			platformAllowedScopes: ['openid', 'email', 'profile'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		}),
	).toMatchObject({
		scopes: ['openid', 'email'],
		platformAppSlug: 'google',
		platformAllowedScopes: ['openid', 'email', 'profile'],
		clientId: 'platform-google-client',
	})

	expect(merge(spotifyQuery)).toMatchObject({
		provider: 'spotify',
		providerKey: 'spotify',
		tokenHost: 'accounts.spotify.com',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		flow: 'pkce',
		usePkce: true,
		tokenExchangeStyle: 'form',
		clientId: '',
		hasClientSecret: false,
	})

	// Slack keeps comma scope separators and extra authorize params.
	expect(
		merge(
			makeQuery('slack', {
				authorizeHost: 'slack.com',
				authorizeUrl: 'https://slack.com/oauth/v2/authorize',
				tokenUrl: 'https://slack.com/api/oauth.v2.access',
				apiBaseUrl: 'https://slack.com/api',
				scopes: ['channels:read', 'chat:write'],
				flow: 'confidential',
				scopeSeparator: ',',
				extraAuthorizeParams: { user_scope: 'identify' },
				allowedHosts: ['slack.com'],
			}),
		),
	).toMatchObject({
		scopeSeparator: ',',
		extraAuthorizeParams: { user_scope: 'identify' },
		usePkce: false,
		hasClientSecret: false,
	})

	const confidentialSetup = summarizeStoredSetupState({
		flow: 'confidential',
		clientId: 'client-id',
		hasStoredClientSecret: false,
	})
	expect(confidentialSetup.isReady).toBe(false)
	expect(confidentialSetup.missingFields.length).toBeGreaterThan(0)
	expect(
		summarizeStoredSetupState({
			flow: 'pkce',
			clientId: 'client-id',
			hasStoredClientSecret: false,
		}),
	).toMatchObject({ isReady: true, missingFields: [] })
})

test('connect OAuth derives Notion basic-json exchange and surfaces provider failures instead of session expiry', () => {
	expect(
		merge(
			makeQuery('notion', {
				authorizeHost: 'api.notion.com',
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
				tokenUrl: 'https://api.notion.com/v1/oauth/token',
				apiBaseUrl: 'https://api.notion.com/v1',
				scopes: [],
				flow: 'confidential',
				scopeSeparator: ' ',
				extraAuthorizeParams: { owner: 'user', response_type: 'code' },
				allowedHosts: ['api.notion.com'],
			}),
		),
	).toMatchObject({
		provider: 'notion',
		tokenUrl: 'https://api.notion.com/v1/oauth/token',
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'basic-json',
		hasClientSecret: false,
	})

	const storedNotion = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'notion',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			apiBaseUrl: 'https://api.notion.com/v1',
			flow: 'confidential',
			clientId: 'notion-client-id-value',
			hasClientSecret: true,
			requiredHosts: ['api.notion.com'],
			tokenExchangeStyle: 'basic-json',
			authorization: {
				authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: { owner: 'user' },
			},
		}),
		null,
	)
	expect(storedNotion?.tokenExchangeStyle).toBe('basic-json')

	const unauthorized = {
		status: 401,
		data: { ok: false, error: 'Unauthorized.' },
	}
	expect(formatOAuthExchangeFailure(unauthorized)).toEqual({
		treatAsSessionExpired: true,
		error: 'Session expired.',
	})
	expect(isOAuthExchangeSessionExpired(unauthorized)).toBe(true)

	expect(
		formatOAuthExchangeFailure({
			status: 502,
			data: {
				ok: false,
				error: 'invalid_client',
				error_description: 'Client authentication failed',
				providerStatus: 401,
			},
		}),
	).toEqual({
		treatAsSessionExpired: false,
		error: 'Client authentication failed',
	})
	expect(
		isOAuthExchangeSessionExpired({
			status: 401,
			data: {
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			},
		}),
	).toBe(false)
})

test('connect OAuth derives Canva confidential + PKCE basic-form defaults and honors explicit overrides', () => {
	const canvaQuery = makeQuery('canva', {
		authorizeHost: 'www.canva.com',
		authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
		tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		apiBaseUrl: 'https://api.canva.com/rest/v1',
		scopes: ['design:content:read'],
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
		allowedHosts: ['api.canva.com'],
	})

	// Canva requires BOTH S256 PKCE and a client secret on token exchange, so
	// the host defaults must combine a confidential flow with PKCE enabled.
	expect(merge(canvaQuery)).toMatchObject({
		provider: 'canva',
		tokenHost: 'api.canva.com',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
		hasClientSecret: false,
	})

	// Explicit query params still win over host defaults.
	expect(
		merge({ ...canvaQuery, usePkce: false, tokenExchangeStyle: 'form' }),
	).toMatchObject({
		flow: 'confidential',
		usePkce: false,
		tokenExchangeStyle: 'form',
	})

	// PKCE can be enabled on top of a confidential flow for any provider.
	expect(
		merge({
			...canvaQuery,
			provider: 'acme',
			providerKey: 'acme',
			authorizeHost: 'auth.acme.test',
			authorizeUrl: 'https://auth.acme.test/oauth/authorize',
			tokenUrl: 'https://auth.acme.test/oauth/token',
			apiBaseUrl: null,
			flow: 'confidential',
			usePkce: true,
			allowedHosts: ['auth.acme.test'],
		}),
	).toMatchObject({
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'form',
		hasClientSecret: false,
	})

	// Reconnects read the persisted PKCE choice back from the stored config.
	const storedCanva = parseStoredIntegrationConfig(
		JSON.stringify({
			name: 'canva',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com/rest/v1',
			flow: 'confidential',
			usePkce: true,
			clientId: 'canva-client-id-value',
			hasClientSecret: true,
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
			authorization: {
				authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
				scopes: ['design:content:read'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		}),
		null,
	)
	expect(storedCanva).toMatchObject({
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
	})
	expect(
		merge(
			{
				...canvaQuery,
				authorizeHost: null,
				authorizeUrl: null,
				tokenUrl: null,
				apiBaseUrl: null,
				scopes: null,
				allowedHosts: [],
			},
			storedCanva,
		),
	).toMatchObject({
		provider: 'canva',
		authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
		tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
		clientId: 'canva-client-id-value',
	})
})

test('shared-app family lookup prefills google-calendar from the google app payload', () => {
	// integrations.json?name=google-calendar resolves the shared `google` app
	// (slug ≠ name) and returns this shape; the client must still merge the
	// client id for a fresh multi-account setup session.
	const storedFromFamilyLookup = parseStoredIntegrationConfig(
		{
			name: 'google-calendar',
			appSlug: 'google',
			provider: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'shared-google-client',
			hasClientSecret: false,
			requiredHosts: [],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
			},
		},
		null,
	)
	expect(storedFromFamilyLookup?.clientId).toBe('shared-google-client')

	const calendarQuery = makeQuery('google-calendar', {
		authorizeHost: 'accounts.google.com',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		extraAuthorizeParams: {},
	})
	expect(
		merge(
			{
				...calendarQuery,
				scopes: ['calendar.readonly'],
				flow: 'pkce',
				scopeSeparator: ' ',
				allowedHosts: ['www.googleapis.com'],
			},
			storedFromFamilyLookup,
		),
	).toMatchObject({
		provider: 'google-calendar',
		clientId: 'shared-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
	})

	const reconnectWithHint = merge(
		{ ...calendarQuery, loginHint: 'kent.c.dodds@gmail.com' },
		storedFromFamilyLookup,
	)
	expect(reconnectWithHint?.extraAuthorizeParams).toEqual({
		access_type: 'offline',
		login_hint: 'kent.c.dodds@gmail.com',
	})
})

test('abandoned setup still prefills client id from a connectionless app on a fresh session', () => {
	// This is the regression: after setup we persist the app (not only session
	// storage). A later visit with no session snapshot must still see the
	// client id via the integrations.json?name= lookup payload.
	const storedFromAppOnlyLookup = parseStoredIntegrationConfig(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientId: 'spotify-client-from-setup',
			hasClientSecret: false,
			requiredHosts: [],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
		null,
	)
	expect(storedFromAppOnlyLookup?.clientId).toBe('spotify-client-from-setup')

	const query = { ...spotifyQuery, scopes: ['user-read-playback-state'] }
	const isReady = (clientId = '') =>
		summarizeStoredSetupState({
			flow: 'pkce',
			clientId,
			hasStoredClientSecret: false,
		}).isReady
	const withPersistedApp = merge(query, storedFromAppOnlyLookup)
	expect(withPersistedApp?.clientId).toBe('spotify-client-from-setup')
	expect(isReady(withPersistedApp?.clientId)).toBe(true)

	// Without the setup-time app persist, a fresh session has no stored
	// integration and the client id field is empty — the bug this test guards.
	const withoutPersistedApp = merge(query)
	expect(withoutPersistedApp?.clientId).toBe('')
	expect(isReady(withoutPersistedApp?.clientId)).toBe(false)
})

test('session config parsing is strict: usePkce and clientId are required and stale shapes are rejected', () => {
	const sessionConfig = {
		provider: 'spotify',
		providerKey: 'spotify',
		authorizeHost: 'accounts.spotify.com',
		tokenHost: 'accounts.spotify.com',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: null,
		scopes: [],
		flow: 'pkce',
		usePkce: true,
		tokenExchangeStyle: 'form',
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
		providerSetupInstructions: null,
		dashboardUrl: null,
		clientId: 'spotify-client-id-value',
		hasClientSecret: false,
		allowedHosts: ['accounts.spotify.com'],
	}
	const parse = (overrides: Record<string, unknown>) =>
		parseSessionConnectOauthConfig(
			JSON.stringify({ ...sessionConfig, ...overrides }),
		)

	expect(parse({})).toMatchObject({
		provider: 'spotify',
		flow: 'pkce',
		usePkce: true,
	})
	const providerMark = '/integrations/provider-marks/google?v=abcdef0123456789'
	expect(parse({ catalogLogoPath: providerMark })).toMatchObject({
		catalogLogoPath: providerMark,
	})
	for (const catalogLogoPath of [
		'/integrations/logos/google',
		'/account/integrations',
	]) {
		expect(parse({ catalogLogoPath })).toMatchObject({ catalogLogoPath: null })
	}
	expect(parse({ flow: 'confidential', usePkce: false })).toMatchObject({
		flow: 'confidential',
		usePkce: false,
	})

	// No back-compat: a snapshot without usePkce (persisted by pre-change code)
	// is rejected and the user restarts the flow; legacy clientIdValueName
	// snapshots are also rejected.
	expect(parse({ usePkce: undefined })).toBeNull()
	expect(
		parse({ clientId: undefined, clientIdValueName: 'spotify-client-id' }),
	).toBeNull()
	expect(parse({ flow: 'implicit' })).toBeNull()
	expect(parseSessionConnectOauthConfig('not json')).toBeNull()
	expect(
		parseSessionConnectOauthConfig(JSON.stringify({ provider: 'x' })),
	).toBeNull()
})

test('parseConnectOauthNextSteps accepts the copyable prompt payload', () => {
	const payload = {
		service: 'google',
		connectionName: 'google-work',
		prompt: 'ask the agent what to do next',
	}
	expect(parseConnectOauthNextSteps(payload)).toEqual(payload)
	const rejected = [
		null,
		{ guidance: 'x' },
		{ service: 'google', connectionName: 'google' },
		{ service: 1, connectionName: 'google', prompt: 'x' },
	]
	expect(
		rejected.filter((v) => parseConnectOauthNextSteps(v) !== null),
	).toEqual([])
})

test('connect OAuth query helpers decode instructions, scopes, and safe URLs', () => {
	const safeUrls: Array<[string, boolean]> = [
		['https://example.com/path', true],
		['http://localhost:8787', true],
		['javascript:alert(1)', false],
		['ftp://files.example.com', false],
	]
	expect(
		safeUrls.filter(([url, want]) => isSafeExternalUrl(url) !== want),
	).toEqual([])
	expect(parseOptionalUrl(null)).toBeNull()
	expect(parseOptionalUrl('https://example.com/a?b=1')).toBe(
		'https://example.com/a?b=1',
	)
	expect(parseOptionalUrl('not a url')).toBeNull()

	expect(decodeBase64Payload('!!!')).toBeNull()
	expect(
		decodeBase64Payload(utf8ToBase64Url('Open the developer console.')),
	).toBe('Open the developer console.')
	expect(isMostlyPrintable('printable text\nwith tabs\tand returns\r')).toBe(
		true,
	)
	expect(isMostlyPrintable('\u0001\u0002\u0003\u0004\u0005')).toBe(false)

	expect(parseExtraParams(null)).toEqual({})
	expect(
		parseExtraParams('{"prompt":"consent","access_type":"offline"}'),
	).toEqual({ prompt: 'consent', access_type: 'offline' })
	expect(parseExtraParams('{"n":1,"b":true,"x":null}')).toEqual({
		n: '1',
		b: 'true',
		x: 'null',
	})
	expect(parseExtraParams('{')).toEqual({})
	expect(parseScopes('repo, read:user  openid')).toEqual([
		'repo',
		'read:user',
		'openid',
	])
	expect(parseScopes('["repo","read:user"]')).toEqual(['repo', 'read:user'])
	expect(parseScopes('[not-json')).toEqual(['[not-json'])

	const plain = 'Visit the provider console and create an OAuth app.'
	const encoded = utf8ToBase64Url(plain)
	expect(parseProviderSetupInstructions(null)).toBeNull()
	expect(parseProviderSetupInstructions(plain)).toBe(plain)
	expect(parseProviderSetupInstructions(`base64:${encoded}`)).toBe(plain)
	expect(parseProviderSetupInstructions(encoded)).toBe(plain)
	expect(parseProviderSetupInstructions('base64:!!!')).toBe('base64:!!!')
})

test('PKCE helpers match RFC 7636 S256 vector and current verifier shape', async () => {
	const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
	await expect(createCodeChallenge(rfcVerifier)).resolves.toBe(
		'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
	)

	const verifier = createCodeVerifier()
	// Current implementation samples 64 random bytes → 86-char base64url (not the
	// 43-char / 32-byte length recommended by RFC 7636 appendix B).
	expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
	expect(verifier).toHaveLength(86)
	await expect(createCodeChallenge(verifier)).resolves.toMatch(
		/^[A-Za-z0-9_-]+$/,
	)
})

test('browser fetch network TypeErrors map to a stable in-page status (KODY-CLOUDFLARE-3P)', () => {
	const firefox = new TypeError(
		'NetworkError when attempting to fetch resource.',
	)
	const chromium = new TypeError('Failed to fetch')
	const cases: Array<[Error, boolean]> = [
		[firefox, true],
		[chromium, true],
		[new TypeError('Failed to fetch (kody.codes)'), true],
		[new TypeError('Load failed'), true],
		[new TypeError('TypeError: Failed to fetch'), true],
		[new TypeError('null is not an object'), false],
		[new Error('Failed to fetch'), false],
		[
			new TypeError(
				'Failed to fetch dynamically imported module: https://kody.codes/assets/x.js',
			),
			false,
		],
	]
	expect(
		cases.filter(([error, want]) => isBrowserFetchNetworkError(error) !== want),
	).toEqual([])

	const networkStatus = formatConnectOauthCaughtError(firefox, 'fallback')
	expect(networkStatus).not.toBe('fallback')
	expect(formatConnectOauthCaughtError(chromium, 'fallback')).toBe(
		networkStatus,
	)
	expect(
		formatConnectOauthCaughtError(
			new Error('Unable to save secret.'),
			'fallback',
		),
	).toBe('Unable to save secret.')
	expect(formatConnectOauthCaughtError('nope', 'fallback')).toBe('fallback')
})

test('success card shows a copyable whats-next prompt for the connected connection', async () => {
	const config = merge(
		makeQuery('google-work', {
			authorizeHost: 'accounts.google.com',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com',
			scopes: ['openid'],
			flow: 'confidential',
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
			allowedHosts: ['www.googleapis.com'],
		}),
	)
	if (!config) throw new Error('expected a merged OAuth config')
	const prompt = 'ask the agent about google-work next steps'
	const render = (
		nextSteps: Parameters<typeof renderSuccessCard>[0]['nextSteps'],
	) =>
		renderToString(
			renderSuccessCard({
				config,
				hostApprovalLinks: [],
				nextSteps,
				approvingAllHosts: false,
				onApproveAllHosts() {},
				connectionHref: '/@ada/-/integrations/google-work',
			}),
		)
	const html = await render({
		service: 'google',
		connectionName: 'google-work',
		prompt,
	})
	expect(html).toContain('data-testid="connect-oauth-whats-next"')
	expect(html).toContain(prompt)
	expect(html).toContain('/@ada/-/integrations/google-work')
	expect(html).not.toContain('google-work with google-work')

	const fallbackHtml = await render(null)
	expect(fallbackHtml).toContain('data-testid="connect-oauth-whats-next"')
	expect(fallbackHtml).toContain('google-work with google-work')
	expect(fallbackHtml).not.toContain(prompt)
})

test('oauth success link uses the signup org when memberships are missing', () => {
	expect(connectOauthConnectionHref(null, 'google-work')).toBe('/account')
	expect(
		connectOauthConnectionHref(
			{ username: 'ada', organizations: [] },
			'google-work',
		),
	).toBe('/@ada/-/integrations/google-work')
	expect(
		connectOauthConnectionHref(
			{
				username: 'ada',
				organizations: [
					{ slug: 'acme', displayName: null, role: 'member', personal: false },
				],
			},
			'google-work',
		),
	).toBe('/@acme/-/integrations/google-work')
	expect(
		connectOauthConnectionHref(
			{
				username: 'ada',
				organizations: [
					{ slug: 'acme', displayName: null, role: 'member', personal: false },
					{ slug: 'ada', displayName: null, role: 'owner', personal: true },
				],
			},
			'google-work',
		),
	).toBe('/@ada/-/integrations/google-work')
})
