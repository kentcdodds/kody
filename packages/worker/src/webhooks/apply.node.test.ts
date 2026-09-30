import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi, type Mock } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	applyWebhookUrlForUser,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
} from './service.ts'

const integrationMocks = vi.hoisted(() => ({
	getJoinedIntegration: vi.fn(),
	resolveIntegrationAccessToken: vi.fn(),
	assertCanUseIntegration: vi.fn(),
	refreshIntegrationTokens: vi.fn(),
}))

const secretMocks = vi.hoisted(() => ({
	resolveSecretForHost: vi.fn(),
	resolveSecret: vi.fn(),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	getJoinedIntegration: (...args: Array<unknown>) =>
		integrationMocks.getJoinedIntegration(...args),
}))

vi.mock('#worker/integrations/credentials.ts', () => ({
	resolveIntegrationAccessToken: (...args: Array<unknown>) =>
		integrationMocks.resolveIntegrationAccessToken(...args),
}))

vi.mock('#worker/integrations/package-access.ts', () => ({
	assertCanUseIntegration: (...args: Array<unknown>) =>
		integrationMocks.assertCanUseIntegration(...args),
}))

vi.mock('#worker/integrations/token-refresh.ts', () => ({
	refreshIntegrationTokens: (...args: Array<unknown>) =>
		integrationMocks.refreshIntegrationTokens(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(async (input: { packageIdOrKodyId: string }) => {
		if (
			input.packageIdOrKodyId === 'pkg-1' ||
			input.packageIdOrKodyId === 'sentry-bridge'
		) {
			return {
				id: 'pkg-1',
				kodyId: 'sentry-bridge',
				name: '@owner/sentry-bridge',
				userId: 'ignored',
				sourceId: 'src-1',
			}
		}
		return null
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => []),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecretForHost: (...args: Array<unknown>) =>
		secretMocks.resolveSecretForHost(...args),
	resolveSecret: (...args: Array<unknown>) =>
		secretMocks.resolveSecret(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(),
}))

type Destination = Parameters<typeof applyWebhookUrlForUser>[0]['destination']

const redirectError = 'Destination redirected. Apply does not follow redirects.'
const hooksRegister = 'https://hooks.example/register'

function mockIntegration(name = 'github', host = 'api.github.com') {
	integrationMocks.getJoinedIntegration.mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: `https://${host}`, requiredHosts: [host] },
		connection: {
			name,
			requiredHosts: [host],
			usageMode: 'any',
			allowedPackageIds: [],
		},
	})
	integrationMocks.resolveIntegrationAccessToken.mockResolvedValue('ghs_test')
	integrationMocks.assertCanUseIntegration.mockResolvedValue(undefined)
}

function mockSecret(value: string, host = 'api.github.com') {
	secretMocks.resolveSecretForHost.mockResolvedValue({
		found: true,
		value,
		allowedHosts: [host],
		scope: 'user',
	})
	secretMocks.resolveSecret.mockResolvedValue({
		found: true,
		value,
		allowedHosts: [host],
		scope: 'user',
	})
}

function mockVerificationSecretWithoutHostAllow(value: string) {
	secretMocks.resolveSecret.mockResolvedValue({
		found: true,
		value,
		allowedHosts: [],
		scope: 'user',
	})
	secretMocks.resolveSecretForHost.mockResolvedValue({
		found: true,
		value,
		allowedHosts: [],
		scope: 'user',
	})
}

function githubHooksHttpDestination(
	input: { includeWebhookSecret?: boolean } = {},
) {
	return {
		type: 'http' as const,
		url: 'https://api.github.com/repos/acme/api/hooks',
		method: 'POST' as const,
		headers: {
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'kody',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({
			name: 'web',
			active: true,
			events: ['push', 'pull_request'],
			config: {
				url: '{{webhookUrl}}',
				content_type: 'json',
				insecure_ssl: '0',
				...(input.includeWebhookSecret ? { secret: '{{webhookSecret}}' } : {}),
			},
		}),
		integration: 'github',
	}
}

function stubFetch<T extends Mock>(fetchMock: T) {
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

function fetchResponding(body: BodyInit | null, init: ResponseInit) {
	return stubFetch(
		vi.fn(
			async (_url: string, _init?: RequestInit) => new Response(body, init),
		),
	)
}

function requestOf(fetchMock: Mock) {
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
	return { url, init, headers: new Headers(init.headers) }
}

function redaction(
	applied: { ok: boolean; error: string | null },
	forbidden: Array<string>,
) {
	const error = applied.error ?? ''
	return {
		ok: applied.ok,
		leaked: forbidden.filter((value) => error.includes(value)),
		redacted: error.includes('[redacted]'),
	}
}

const redactedFailure = { ok: false, leaked: [], redacted: true }

async function setupOwner(input: { verification?: boolean } = {}) {
	vi.mocked(loadPackageManifestBySourceId).mockResolvedValue({
		manifest: {
			name: '@owner/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						...(input.verification
							? {
									verification: {
										type: 'hmac-sha256',
										header: 'x-hub-signature-256',
										secretName: 'githubWebhookSecret',
										encoding: 'hex',
									},
								}
							: {}),
					},
				],
			},
		},
	} as never)
	const userId = await createStableUserIdFromEmail('owner@example.com')
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			previous_url_secret_hash TEXT,
			previous_url_secret_expires_at TEXT,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_webhook_endpoints_user_package_name
		ON webhook_endpoints(user_id, package_id, webhook_name);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://heykody.dev',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('owner', 'owner@example.com', 'hash', ?)`,
		)
		.bind(userId)
		.run()
	const { handle } = await mintWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	secretMocks.resolveSecretForHost.mockReset()
	return {
		userId,
		db,
		reveal: async () =>
			(
				await revealWebhookUrlForWebsite({
					env,
					userId,
					username: 'owner',
					target: { handle },
				})
			).url,
		apply: (destination: Destination) =>
			applyWebhookUrlForUser({
				env,
				userId,
				username: 'owner',
				handle,
				destination,
			}),
	}
}

test('webhookUrlApply registers a GitHub repo hook via http destination without exposing the URL', async () => {
	const { userId, db, reveal, apply } = await setupOwner()
	const url = await reveal()
	mockIntegration()
	using fetchMock = fetchResponding(
		JSON.stringify({ id: 4242, config: { url } }),
		{ status: 201 },
	)

	const applied = await apply(githubHooksHttpDestination())

	expect(applied).toEqual({
		ok: true,
		urlHost: 'heykody.dev',
		httpStatus: 201,
		remoteId: '4242',
		error: null,
	})
	expect(JSON.stringify(applied)).not.toContain(url)
	expect(JSON.stringify(applied)).not.toContain(
		url.slice(url.lastIndexOf('/') + 1),
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const request = requestOf(fetchMock)
	expect({
		url: request.url,
		method: request.init.method,
		redirect: request.init.redirect,
		headers: Object.fromEntries(request.headers),
		body: JSON.parse(String(request.init.body)),
	}).toMatchObject({
		url: 'https://api.github.com/repos/acme/api/hooks',
		method: 'POST',
		redirect: 'manual',
		headers: {
			accept: 'application/vnd.github+json',
			'content-type': 'application/json',
			'user-agent': 'kody',
			'x-github-api-version': '2022-11-28',
			authorization: 'Bearer ghs_test',
		},
		body: { config: { url }, events: ['push', 'pull_request'] },
	})
	expect(integrationMocks.assertCanUseIntegration).toHaveBeenCalledWith(
		expect.objectContaining({ userId, name: 'github', packageId: 'pkg-1' }),
	)

	await db
		.prepare(
			`UPDATE webhook_endpoints SET url_secret_encrypted = NULL
			WHERE user_id = ?`,
		)
		.bind(userId)
		.run()
	await expect(apply(githubHooksHttpDestination())).rejects.toThrow(
		'not recoverable',
	)
})

test('webhookUrlApply does not follow credential-bearing or plain http redirects', async () => {
	const cases: Array<[Destination, number]> = [
		[githubHooksHttpDestination(), 307],
		[
			{ type: 'http', url: hooksRegister, body: '{"url":"{{webhookUrl}}"}' },
			302,
		],
	]
	for (const [destination, status] of cases) {
		const { apply } = await setupOwner()
		mockIntegration()
		using fetchMock = fetchResponding(null, {
			status,
			headers: { Location: 'https://attacker.example/exfil' },
		})

		expect(await apply(destination)).toEqual({
			ok: false,
			urlHost: 'heykody.dev',
			httpStatus: status,
			remoteId: null,
			error: redirectError,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(requestOf(fetchMock).init.redirect).toBe('manual')
	}
})

test('webhookUrlApply registers via http destination with {{webhookUrl}} substitution', async () => {
	const { reveal, apply } = await setupOwner()
	const url = await reveal()
	using fetchMock = fetchResponding(JSON.stringify({ id: 'reg-9', url }), {
		status: 200,
	})

	const applied = await apply({
		type: 'http',
		url: hooksRegister,
		headers: { 'Content-Type': 'application/json' },
		body: '{"url":"{{webhookUrl}}"}',
	})

	expect(applied).toEqual({
		ok: true,
		urlHost: 'heykody.dev',
		httpStatus: 200,
		remoteId: 'reg-9',
		error: null,
	})
	expect(JSON.stringify(applied)).not.toContain(url)
	expect(JSON.stringify(applied)).not.toContain(
		url.slice(url.lastIndexOf('/') + 1),
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const request = requestOf(fetchMock)
	expect({
		url: request.url,
		method: request.init.method,
		redirect: request.init.redirect,
		hasAuthorization: request.headers.has('Authorization'),
		contentType: request.headers.get('Content-Type'),
		body: JSON.parse(String(request.init.body)),
	}).toEqual({
		url: hooksRegister,
		method: 'POST',
		redirect: 'manual',
		hasAuthorization: false,
		contentType: 'application/json',
		body: { url },
	})
})

test('webhookUrlApply rejects invalid destinations before fetch', async () => {
	const cases: Array<[Destination, string | RegExp]> = [
		[
			{ type: 'http', url: hooksRegister, body: '{"ok":true}' },
			'{{webhookUrl}}',
		],
		[
			{
				type: 'http',
				url: hooksRegister,
				headers: { Authorization: 'Bearer manual' },
				body: '{"url":"{{webhookUrl}}"}',
				secretName: 'hooksToken',
			},
			/Authorization/,
		],
		[
			githubHooksHttpDestination({ includeWebhookSecret: true }),
			/verification\.secretName/,
		],
	]
	for (const [destination, message] of cases) {
		const { apply } = await setupOwner()
		mockIntegration()
		using fetchMock = stubFetch(vi.fn())
		await expect(apply(destination)).rejects.toThrow(message)
		expect(fetchMock).not.toHaveBeenCalled()
	}
})

test('webhookUrlApply http destination encodes {{webhookUrl}} in URLs and form bodies', async () => {
	const { reveal, apply } = await setupOwner()
	const url = await reveal()
	{
		using fetchMock = fetchResponding(JSON.stringify({ id: 7 }), {
			status: 201,
		})
		const applied = await apply({
			type: 'http',
			method: 'PUT',
			url: `${hooksRegister}?callback={{webhookUrl}}`,
		})
		expect(applied).toEqual({
			ok: true,
			urlHost: 'heykody.dev',
			httpStatus: 201,
			remoteId: '7',
			error: null,
		})
		expect(JSON.stringify(applied)).not.toContain(url)
		expect(requestOf(fetchMock).url).toBe(
			`${hooksRegister}?callback=${encodeURIComponent(url)}`,
		)
	}

	using fetchMock = fetchResponding(JSON.stringify({ id: 'form-1' }), {
		status: 200,
	})
	const applied = await apply({
		type: 'http',
		url: hooksRegister,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `callback=${encodeURIComponent('{{webhookUrl}}')}`,
	})
	expect(applied.ok).toBe(true)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(String(requestOf(fetchMock).init.body)).toContain(
		encodeURIComponent(url),
	)
})

test('webhookUrlApply redacts percent-encoded webhook URLs and secretName Bearer tokens from errors', async () => {
	const { reveal, apply } = await setupOwner()
	const url = await reveal()
	const destination = {
		type: 'http',
		url: hooksRegister,
		body: '{"url":"{{webhookUrl}}"}',
	} as const
	{
		using _fetch = fetchResponding(
			`invalid callback ${encodeURIComponent(url)}`,
			{ status: 400 },
		)
		expect(
			redaction(await apply(destination), [url, encodeURIComponent(url)]),
		).toEqual(redactedFailure)
	}

	const token = 'tok_super_secret_apply_auth'
	mockSecret(token, 'hooks.example')
	using _fetch = fetchResponding(`unauthorized Bearer ${token}`, {
		status: 401,
	})
	expect(
		redaction(await apply({ ...destination, secretName: 'hooksToken' }), [
			token,
		]),
	).toEqual(redactedFailure)
})

test('webhookUrlApply redacts refreshed Authorization tokens after 401 retry', async () => {
	const { apply } = await setupOwner()
	const initialToken = 'tok_initial_apply_auth'
	const refreshedToken = 'tok_refreshed_apply_auth'
	mockIntegration('hooks', 'hooks.example')
	integrationMocks.resolveIntegrationAccessToken
		.mockResolvedValueOnce(initialToken)
		.mockResolvedValue(refreshedToken)
	integrationMocks.refreshIntegrationTokens.mockResolvedValue(undefined)
	using _fetch = stubFetch(
		vi.fn(async (_url: string, init?: RequestInit) => {
			const auth = new Headers(init?.headers).get('Authorization') ?? ''
			return auth.includes(initialToken)
				? new Response('unauthorized', { status: 401 })
				: new Response(`invalid ${encodeURIComponent(auth)}`, { status: 400 })
		}),
	)

	const applied = await apply({
		type: 'http',
		url: hooksRegister,
		body: '{"url":"{{webhookUrl}}"}',
		integration: 'hooks',
	})

	expect(
		redaction(applied, [
			initialToken,
			refreshedToken,
			encodeURIComponent(`Bearer ${refreshedToken}`),
			encodeURIComponent(refreshedToken),
		]),
	).toEqual(redactedFailure)
	expect(integrationMocks.refreshIntegrationTokens).toHaveBeenCalled()
})

test('webhookUrlApply injects JSON-escaped {{webhookSecret}} from verification.secretName', async () => {
	const { reveal, apply } = await setupOwner({ verification: true })
	const url = await reveal()
	mockIntegration()
	const secrets: Array<[string, string]> = [
		['hook_signing_secret_value', '99'],
		['hook"with\\quotes\nand\tnewline', '100'],
	]
	for (const [hookSecret, remoteId] of secrets) {
		mockSecret(hookSecret)
		using fetchMock = fetchResponding(
			JSON.stringify({ id: Number(remoteId) }),
			{
				status: 201,
			},
		)

		const applied = await apply(
			githubHooksHttpDestination({ includeWebhookSecret: true }),
		)

		expect({ ok: applied.ok, remoteId: applied.remoteId }).toEqual({
			ok: true,
			remoteId,
		})
		expect(JSON.stringify(applied)).not.toContain(hookSecret)
		const raw = String(requestOf(fetchMock).init.body)
		expect(raw).toContain(JSON.stringify(hookSecret).slice(1, -1))
		expect(JSON.parse(raw).config).toMatchObject({ url, secret: hookSecret })
	}
	expect(secretMocks.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'githubWebhookSecret',
		}),
	)
	expect(secretMocks.resolveSecretForHost).not.toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'githubWebhookSecret',
		}),
	)
})

test('webhookUrlApply injects {{webhookSecret}} without a separate secret host Allow for the destination', async () => {
	// Regression: after destination Allow, HMAC signing secrets must not demand
	// a second Allow for the apply host (e.g. prDeskGithubWebhookSecret →
	// api.github.com). Destination Bearer auth still requires host Allow.
	const { reveal, apply } = await setupOwner({ verification: true })
	const url = await reveal()
	mockIntegration()
	const hookSecret = 'pr_desk_hmac_without_host_allow'
	mockVerificationSecretWithoutHostAllow(hookSecret)
	using fetchMock = fetchResponding(JSON.stringify({ id: 42 }), {
		status: 201,
	})

	const applied = await apply(
		githubHooksHttpDestination({ includeWebhookSecret: true }),
	)

	expect(applied).toMatchObject({ ok: true, remoteId: '42' })
	expect(JSON.parse(String(requestOf(fetchMock).init.body)).config).toEqual(
		expect.objectContaining({ url, secret: hookSecret }),
	)
	expect(secretMocks.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'githubWebhookSecret' }),
	)
	expect(secretMocks.resolveSecretForHost).not.toHaveBeenCalled()
})

test('webhookUrlApply still requires host Allow for destination.secretName Bearer auth', async () => {
	const { apply } = await setupOwner()
	secretMocks.resolveSecretForHost.mockResolvedValue({
		found: true,
		value: 'tok_unapproved',
		allowedHosts: [],
		scope: 'user',
	})

	await expect(
		apply({
			type: 'http',
			url: hooksRegister,
			body: '{"url":"{{webhookUrl}}"}',
			secretName: 'hooksRegistrationToken',
		}),
	).rejects.toThrow(/not approved for host "hooks\.example"/)
})

test('webhookUrlApply redacts {{webhookSecret}} from JSON and form-encoded error bodies', async () => {
	const { apply } = await setupOwner({ verification: true })
	const hookSecret = 'hook_signing_secret_for_redaction'
	mockIntegration()
	mockSecret(hookSecret)
	{
		using _fetch = fetchResponding(`invalid secret ${hookSecret}`, {
			status: 400,
		})
		expect(
			redaction(
				await apply(githubHooksHttpDestination({ includeWebhookSecret: true })),
				[hookSecret],
			),
		).toEqual(redactedFailure)
	}

	const spacedSecret = 'hook secret with spaces'
	mockSecret(spacedSecret, 'hooks.example')
	const formEncoded = new URLSearchParams({ v: spacedSecret })
		.toString()
		.slice('v='.length)
	expect(formEncoded).toContain('+')
	using _fetch = fetchResponding(`bad callback ${formEncoded}`, { status: 400 })
	const formApplied = await apply({
		type: 'http',
		url: hooksRegister,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `url=${encodeURIComponent('{{webhookUrl}}')}&secret=${encodeURIComponent('{{webhookSecret}}')}`,
	})
	expect(redaction(formApplied, [spacedSecret, formEncoded])).toEqual(
		redactedFailure,
	)
})
