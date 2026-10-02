import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { mintApiToken } from '#worker/api-tokens/service.ts'
import { cliClientIdMetadataPath } from '#worker/cli-client-metadata.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { handleOpenApiRequest } from './http-handler.ts'

type ApiResponseBody = Record<string, unknown> & {
	error?: { code: string; message: string; details?: unknown }
}

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const apiOrigin = 'https://api.kody.test'
const appOrigin = 'https://kody.test'

async function createApi(
	input: {
		emailVerified?: boolean
		suspended?: boolean
		localExecuteFlag?: boolean
		oauthAccessToken?: string | null
		oauthAudience?: string | Array<string>
		oauthClientId?: string
		oauthExpiresAtUnix?: number
		oauthUnwrapFails?: boolean
		captureUsage?: Array<{
			blobs: Array<string | null | undefined>
			indexes?: Array<string | null | undefined>
		}>
	} = {},
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const email = 'api-user@example.com'
	const userId = await createStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at, suspended_at)
			 VALUES (1, 'api-user', ?, 'hash', ?, ?, ?)`,
		)
		.run(
			email,
			userId,
			input.emailVerified === false ? null : '2026-01-01T00:00:00.000Z',
			input.suspended ? '2026-01-01T00:00:00.000Z' : null,
		)
	if (input.localExecuteFlag) {
		sqlite
			.prepare(
				`INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled) VALUES ('local-execute', 1, 1)`,
			)
			.run()
	}
	const db = createD1FromSqlite(sqlite)
	const oauthAccessToken = input.oauthAccessToken
	const oauthExpiresAtUnix =
		input.oauthExpiresAtUnix ?? Math.floor(Date.now() / 1000) + 3600
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
		...(oauthAccessToken !== undefined
			? {
					OAUTH_PROVIDER: {
						async unwrapToken(token: string) {
							if (input.oauthUnwrapFails) return null
							if (token !== oauthAccessToken) return null
							return {
								createdAt: Math.floor(Date.now() / 1000) - 60,
								expiresAt: oauthExpiresAtUnix,
								audience: input.oauthAudience ?? appOrigin,
								scope: ['openid', 'profile', 'email'],
								grant: {
									clientId:
										input.oauthClientId ??
										`${appOrigin}${cliClientIdMetadataPath}`,
									scope: ['openid', 'profile', 'email'],
									props: {
										userId,
										email,
										username: 'api-user',
										displayName: 'API User',
										authTime: Math.floor(Date.now() / 1000) - 60,
									},
								},
							}
						},
					},
				}
			: {}),
		...(input.captureUsage
			? {
					USAGE_EVENTS: {
						writeDataPoint(point?: {
							blobs?: Array<string | null | undefined>
							indexes?: Array<string | null | undefined>
						}) {
							input.captureUsage?.push({
								blobs: point?.blobs ?? [],
								indexes: point?.indexes,
							})
						},
					},
				}
			: {}),
	} as unknown as Env
	const pending: Array<Promise<unknown>> = []
	async function call(
		method: string,
		path: string,
		options: { token?: string; body?: unknown; contentType?: string } = {},
	) {
		const headers = new Headers()
		if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
		if (options.body !== undefined) {
			headers.set('Content-Type', options.contentType ?? 'application/json')
		}
		const response = await handleOpenApiRequest({
			request: new Request(`${apiOrigin}${path}`, {
				method,
				headers,
				...(options.body === undefined
					? {}
					: {
							body:
								typeof options.body === 'string'
									? options.body
									: JSON.stringify(options.body),
						}),
			}),
			env,
			appOrigin,
			waitUntil: (promise) => pending.push(promise),
		})
		await Promise.all(pending.splice(0))
		return {
			status: response.status,
			headers: response.headers,
			body: (await response.json()) as ApiResponseBody,
		}
	}
	async function mint(scopes: Array<string>) {
		const minted = await mintApiToken({
			db,
			userId,
			name: 'test',
			scopes,
			createdVia: 'api',
			allowLocalExecute: false,
		})
		return minted.token
	}
	return { sqlite, db, env, userId, call, mint, oauthAccessToken }
}

test('serves the OpenAPI document without auth', async () => {
	const api = await createApi()
	const response = await api.call('GET', '/openapi.json')
	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
	expect(response.body['openapi']).toBe('3.1.0')
	expect(response.body['servers']).toEqual([{ url: apiOrigin }])
})

test('rejects missing, invalid, and revoked tokens with 401', async () => {
	const api = await createApi()
	const missing = await api.call('GET', '/v1/me')
	expect(missing.status).toBe(401)
	expect(missing.headers.get('WWW-Authenticate')).toBe(
		'Bearer realm="kody-api"',
	)
	expect(missing.body.error?.code).toBe('unauthorized')

	const token = await api.mint(['account:read'])
	const tampered = `${token.slice(0, -4)}AAAA`
	const invalid = await api.call('GET', '/v1/me', { token: tampered })
	expect(invalid.status).toBe(401)
	expect(invalid.headers.get('WWW-Authenticate')).toContain(
		'error="invalid_token"',
	)
	expect(JSON.stringify(invalid.body)).not.toContain(tampered)

	const revoke = await api.call('DELETE', '/v1/tokens/current', { token })
	expect(revoke.status).toBe(200)
	expect(revoke.body).toMatchObject({ revoked: true })
	const afterRevoke = await api.call('GET', '/v1/me', { token })
	expect(afterRevoke.status).toBe(401)
	expect(afterRevoke.body.error?.message).toMatch(/revoked/)
})

test('runs capability operations under the token scope and slides expiry', async () => {
	const api = await createApi()
	const token = await api.mint(['account:read'])
	const me = await api.call('GET', '/v1/me', { token })
	expect(me.status).toBe(200)
	expect(JSON.stringify(me.body)).toContain('api-user@example.com')

	const current = await api.call('GET', '/v1/tokens/current', { token })
	expect(current.status).toBe(200)
	expect(current.body).toMatchObject({
		scopes: ['account:read'],
		status: 'active',
	})
	expect(current.body['last_used_at']).toEqual(expect.any(String))
	expect(current.body).not.toHaveProperty('token')

	const denied = await api.call('GET', '/v1/secrets', { token })
	expect(denied.status).toBe(403)
	expect(denied.body['error']).toMatchObject({
		code: 'insufficient_scope',
		details: { required_scope: 'secrets:read' },
	})

	const usage = api.sqlite
		.prepare(
			`SELECT event_count, error_count FROM usage_rollups WHERE metric = 'api_call' AND user_id = ?`,
		)
		.get(api.userId)
	expect(usage).toEqual({ event_count: 2, error_count: 0 })
})

test('writes secrets through path params and never returns the value', async () => {
	const api = await createApi()
	const token = await api.mint(['secrets:write'])
	const saved = await api.call('PUT', '/v1/secrets/user/api-test-secret', {
		token,
		body: { value: 'super-secret-value', description: 'from the api' },
	})
	expect(saved.status).toBe(200)
	expect(JSON.stringify(saved.body)).not.toContain('super-secret-value')

	const listed = await api.call('GET', '/v1/secrets?scope=user', { token })
	expect(listed.status).toBe(200)
	expect(JSON.stringify(listed.body)).toContain('api-test-secret')
	expect(JSON.stringify(listed.body)).not.toContain('super-secret-value')

	const conflict = await api.call('PUT', '/v1/secrets/user/api-test-secret', {
		token,
		body: { name: 'other', value: 'x' },
	})
	expect(conflict.status).toBe(400)

	const wrongType = await api.call('PUT', '/v1/secrets/user/x', {
		token,
		body: 'value=x',
		contentType: 'text/plain',
	})
	expect(wrongType.status).toBe(415)
})

test('token minting enforces parent scopes and the local-execute flag', async () => {
	const api = await createApi()
	const parent = await api.mint(['tokens:write', 'packages:read'])
	const child = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'child', scopes: ['packages:read'], idle_ttl_seconds: 300 },
	})
	expect(child.status).toBe(200)
	expect(child.body).toMatchObject({
		scopes: ['packages:read'],
		idle_ttl_seconds: 300,
		token_type: 'Bearer',
		created_via: 'api',
	})
	expect(child.body['token']).toMatch(/^kody_at_/)

	const escalate = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'escalate', scopes: ['secrets:read'] },
	})
	expect(escalate.status).toBe(400)

	const localExecute = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'local', scopes: ['local-execute'] },
	})
	expect(localExecute.status).toBe(400)

	const listed = await api.call('GET', '/v1/tokens', { token: parent })
	expect(listed.status).toBe(200)
	expect(listed.body['tokens']).toHaveLength(2)
	expect(JSON.stringify(listed.body)).not.toContain(child.body['token'])
})

test('a token can only rotate tokens it could have minted', async () => {
	const api = await createApi()
	const rotator = await api.mint(['tokens:write'])
	const stronger = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'stronger',
		scopes: ['secrets:write'],
		createdVia: 'mcp-api',
		allowLocalExecute: false,
	})
	const denied = await api.call('POST', `/v1/tokens/${stronger.id}/rotate`, {
		token: rotator,
	})
	expect(denied.status).toBe(403)
	expect(denied.body.error).toMatchObject({
		code: 'insufficient_scope',
		details: { missing_scopes: ['secrets:write'] },
	})
	expect(JSON.stringify(denied.body)).not.toMatch(/kody_at_/)
	const stillWorks = await api.call('GET', '/v1/secrets', {
		token: stronger.token,
	})
	expect(stillWorks.status).toBe(200)

	const longerLived = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'longer',
		scopes: ['tokens:write'],
		maxLifetimeSeconds: 7 * 24 * 60 * 60,
		createdVia: 'mcp-api',
		allowLocalExecute: false,
	})
	const outlives = await api.call(
		'POST',
		`/v1/tokens/${longerLived.id}/rotate`,
		{ token: rotator },
	)
	expect(outlives.status).toBe(403)
	expect(outlives.body.error?.message).toMatch(/outlives/)

	const peer = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'peer',
		scopes: ['tokens:read'],
		maxLifetimeSeconds: 60 * 60,
		createdVia: 'api',
		allowLocalExecute: false,
	})
	const allowed = await api.call('POST', `/v1/tokens/${peer.id}/rotate`, {
		token: rotator,
	})
	expect(allowed.status).toBe(200)
	expect(allowed.body['token']).toMatch(/^kody_at_/)
})

test('reported expiry includes the slide from the current request', async () => {
	const api = await createApi()
	const minted = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'aged',
		scopes: ['account:read'],
		createdVia: 'api',
		allowLocalExecute: false,
		now: new Date(Date.now() - 5 * 60 * 1000),
	})
	const before = Date.now()
	const current = await api.call('GET', '/v1/tokens/current', {
		token: minted.token,
	})
	expect(current.status).toBe(200)
	const reported = Date.parse(String(current.body['expires_at']))
	expect(reported).toBeGreaterThan(Date.parse(minted.expires_at))
	expect(reported).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000)
	const stored = api.sqlite
		.prepare(`SELECT expires_at FROM api_tokens WHERE id = ?`)
		.get(minted.id) as { expires_at: string }
	expect(stored.expires_at).toBe(current.body['expires_at'])
})

test('local-execute tokens are mintable only with the flag and a holding parent', async () => {
	const api = await createApi({ localExecuteFlag: true })
	const parent = await mintWithLocalExecute(api)
	const minted = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'local', scopes: ['local-execute'] },
	})
	expect(minted.status).toBe(200)
	expect(minted.body['scopes']).toEqual(['local-execute'])
})

async function mintWithLocalExecute(
	api: Awaited<ReturnType<typeof createApi>>,
) {
	const minted = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'parent',
		scopes: ['tokens:write', 'local-execute'],
		createdVia: 'mcp-api',
		allowLocalExecute: true,
	})
	return minted.token
}

test('capability proxy session matches the CLI preflight contract', async () => {
	const api = await createApi({ localExecuteFlag: true })
	const token = await mintWithLocalExecute(api)
	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(session.status).toBe(200)
	expect(session.body).toMatchObject({
		scopes: ['local-execute', 'tokens:write'],
		expiresAt: expect.any(String),
		maxExpiresAt: expect.any(String),
		user: { userId: api.userId, email: 'api-user@example.com' },
	})

	const noScope = await api.call('GET', '/v1/capability-proxy/session', {
		token: await api.mint(['account:read']),
	})
	expect(noScope.status).toBe(403)
	expect(noScope.body.error?.code).toBe('insufficient_scope')

	const bad = await api.call('GET', '/v1/capability-proxy/session', {
		token: `${token.slice(0, -4)}AAAA`,
	})
	expect(bad.status).toBe(401)
})

test('capability proxy answers feature_disabled when local-execute is off', async () => {
	const api = await createApi({ localExecuteFlag: true })
	const token = await mintWithLocalExecute(api)
	api.sqlite.prepare(`DELETE FROM feature_flag_user_overrides`).run()
	for (const [method, path, body] of [
		['GET', '/v1/capability-proxy/session', undefined],
		['POST', '/v1/capability-proxy/call', { path: ['kody', 'x'], args: [] }],
	] as const) {
		const response = await api.call(method, path, { token, body })
		expect(response.status).toBe(403)
		expect(response.body['error']).toMatchObject({
			code: 'feature_disabled',
			details: { feature_flag: 'local-execute' },
		})
		expect(response.body.error?.message).toContain('local-execute')
	}
	const noScope = await api.call('GET', '/v1/capability-proxy/session', {
		token: await api.mint(['account:read']),
	})
	expect(noScope.body.error?.code).toBe('feature_disabled')
})

test('capability proxy prefers feature_disabled over malformed body parse errors', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ localExecuteFlag: true, captureUsage: points })
	const token = await mintWithLocalExecute(api)
	api.sqlite.prepare(`DELETE FROM feature_flag_user_overrides`).run()

	const response = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: '{not-json',
	})
	expect(response.status).toBe(403)
	expect(response.body.error?.code).toBe('feature_disabled')
	expect(
		points.filter(
			(point) =>
				point.blobs[1] === 'api_call' &&
				point.blobs[2] === 'capabilityProxyCall:feature_disabled' &&
				point.indexes?.[0] === api.userId,
		),
	).toHaveLength(1)
})

test('incorrect CapabilityProxy secrets do not attribute api_call usage to the owner', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ localExecuteFlag: true, captureUsage: points })
	const token = await mintWithLocalExecute(api)
	const wrongSecret = `${token.slice(0, -4)}AAAA`

	const response = await api.call('GET', '/v1/capability-proxy/session', {
		token: wrongSecret,
	})
	expect(response.status).toBe(401)
	expect(
		points.filter(
			(point) =>
				point.blobs[1] === 'api_call' && point.indexes?.[0] === api.userId,
		),
	).toEqual([])
})

test('capability proxy records distinguishable observe-only api_call telemetry', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ localExecuteFlag: true, captureUsage: points })
	const token = await mintWithLocalExecute(api)

	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(session.status).toBe(200)

	api.sqlite.prepare(`DELETE FROM feature_flag_user_overrides`).run()
	const disabled = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(disabled.status).toBe(403)
	expect(disabled.body.error?.code).toBe('feature_disabled')

	await api.call('DELETE', '/v1/tokens/current', { token })
	const revoked = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(revoked.status).toBe(401)

	const proxyCalls = points.filter(
		(point) =>
			point.blobs[1] === 'api_call' &&
			String(point.blobs[2] ?? '').startsWith('capabilityProxySession'),
	)
	expect(proxyCalls.map((point) => [point.blobs[2], point.blobs[3]])).toEqual([
		['capabilityProxySession', 'success'],
		['capabilityProxySession:feature_disabled', 'error'],
		['capabilityProxySession:unauthorized', 'error'],
	])
	expect(proxyCalls.every((point) => point.indexes?.[0] === api.userId)).toBe(
		true,
	)
	expect(
		points.some(
			(point) =>
				point.blobs[1] === 'execute' || point.blobs[1] === 'dynamic_worker_day',
		),
	).toBe(false)
})

test('capability proxy runs kody:runtime calls and meters each hop', async () => {
	const api = await createApi({ localExecuteFlag: true })
	const token = await mintWithLocalExecute(api)
	const me = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(me.status).toBe(200)
	expect(me.body).toEqual({ result: expect.any(Object) })
	expect(JSON.stringify(me.body['result'])).toContain('api-user@example.com')

	const unknown = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'noSuchCapability'], args: [] },
	})
	expect(unknown.status).toBe(404)
	expect(unknown.body.error?.message).toContain('kody.noSuchCapability')

	for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
		const response = await api.call('POST', '/v1/capability-proxy/call', {
			token,
			body: { path: ['kody', inherited], args: [] },
		})
		expect(response.status).toBe(404)
	}

	const unknownRoot = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['fetch', 'raw'], args: [] },
	})
	expect(unknownRoot.status).toBe(404)

	const missingServer = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'mcp', 'home', 'lights_on'], args: [{}] },
	})
	expect(missingServer.status).toBe(404)
	expect(missingServer.body.error?.message).toContain('home')

	const extraKey = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [], extra: true },
	})
	expect(extraKey.status).toBe(400)

	const usage = api.sqlite
		.prepare(
			`SELECT event_count FROM usage_rollups WHERE metric = 'api_call' AND user_id = ?`,
		)
		.get(api.userId) as { event_count: number }
	expect(usage.event_count).toBe(8)
	const executeUsage = api.sqlite
		.prepare(
			`SELECT COUNT(*) AS count FROM usage_rollups WHERE metric IN ('execute', 'dynamic_worker_day') AND user_id = ?`,
		)
		.get(api.userId)
	expect(executeUsage).toEqual({ count: 0 })

	await api.call('DELETE', '/v1/tokens/current', { token })
	const revoked = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(revoked.status).toBe(401)
})

test('mirrors the /mcp account gates', async () => {
	const unverified = await createApi({ emailVerified: false })
	const unverifiedToken = await unverified.mint(['account:read'])
	const unverifiedResponse = await unverified.call('GET', '/v1/me', {
		token: unverifiedToken,
	})
	expect(unverifiedResponse.status).toBe(403)
	expect(unverifiedResponse.body.error?.code).toBe(
		'email_verification_required',
	)

	const suspended = await createApi({ suspended: true })
	const suspendedToken = await suspended.mint(['account:read'])
	const suspendedResponse = await suspended.call('GET', '/v1/me', {
		token: suspendedToken,
	})
	expect(suspendedResponse.status).toBe(403)
	expect(suspendedResponse.body.error?.code).toBe('account_suspended')

	const reset = await createApi()
	const resetToken = await reset.mint(['account:read'])
	reset.sqlite
		.prepare(`UPDATE users SET password_changed_at = ? WHERE id = 1`)
		.run(new Date(Date.now() + 1000).toISOString())
	const resetResponse = await reset.call('GET', '/v1/me', { token: resetToken })
	expect(resetResponse.status).toBe(401)

	const deleting = await createApi()
	const deletingToken = await deleting.mint(['account:read'])
	deleting.sqlite
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = 1`)
		.run(new Date().toISOString())
	const deletingResponse = await deleting.call('GET', '/v1/me', {
		token: deletingToken,
	})
	expect(deletingResponse.status).toBe(401)
})

test('unknown routes and methods use the error envelope', async () => {
	const api = await createApi()
	const missing = await api.call('GET', '/v1/nope')
	expect(missing.status).toBe(404)
	expect(missing.body.error?.code).toBe('not_found')
	const method = await api.call('PATCH', '/v1/tokens')
	expect(method.status).toBe(405)
	expect(method.headers.get('Allow')).toBe('GET, POST')
})

test('local-execute package-graph requires flag + scope and meters as api_call prep', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ localExecuteFlag: true, captureUsage: points })
	const token = await mintWithLocalExecute(api)

	const empty = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: 'export default async function main() { return 1 }',
		},
	})
	expect(empty.status).toBe(200)
	expect(empty.body).toEqual({ modules: [], imports: [], warnings: [] })

	const dynamic = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `const m = await import('kody:@missing/pkg/export')
export default async () => m`,
		},
	})
	expect(dynamic.status).toBe(400)
	expect(dynamic.body.error?.code).toBe('unsupported_dynamic_package_import')

	const unresolved = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `import x from 'kody:@missing/pkg/export'
export default async () => x`,
		},
	})
	expect(unresolved.status).toBe(400)
	expect(unresolved.body.error?.code).toBe('package_import_unresolved')

	const noScope = await api.call('POST', '/v1/local-execute/package-graph', {
		token: await api.mint(['account:read']),
		body: { code: 'export default async function main() { return 1 }' },
	})
	expect(noScope.status).toBe(403)
	expect(noScope.body.error?.code).toBe('insufficient_scope')

	api.sqlite.prepare(`DELETE FROM feature_flag_user_overrides`).run()
	const disabled = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: { code: 'export default async function main() { return 1 }' },
	})
	expect(disabled.status).toBe(403)
	expect(disabled.body.error?.code).toBe('feature_disabled')

	const packageGraphCalls = points.filter(
		(point) =>
			point.blobs[1] === 'api_call' &&
			String(point.blobs[2] ?? '').startsWith('localExecutePackageGraph'),
	)
	expect(
		packageGraphCalls.map((point) => [point.blobs[2], point.blobs[3]]),
	).toEqual(
		expect.arrayContaining([
			['localExecutePackageGraph', 'success'],
			['localExecutePackageGraph:unsupported_dynamic_package_import', 'error'],
			['localExecutePackageGraph:package_import_unresolved', 'error'],
			['localExecutePackageGraph:insufficient_scope', 'error'],
			['localExecutePackageGraph:feature_disabled', 'error'],
		]),
	)
	expect(
		points.some(
			(point) =>
				point.blobs[1] === 'execute' || point.blobs[1] === 'dynamic_worker_day',
		),
	).toBe(false)
})

test('MCP OAuth Bearer authenticates CapabilityProxy and package-graph when local-execute is on', async () => {
	const oauthToken = 'cli-oauth-access-token-not-kody-at'
	const api = await createApi({
		localExecuteFlag: true,
		oauthAccessToken: oauthToken,
		oauthAudience: `${appOrigin}/mcp`,
	})

	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token: oauthToken,
	})
	expect(session.status).toBe(200)
	expect(session.body).toMatchObject({
		scopes: ['local-execute'],
		expiresAt: expect.any(String),
		maxExpiresAt: expect.any(String),
		idleTtlSeconds: expect.any(Number),
		user: { userId: api.userId, email: 'api-user@example.com' },
		limits: {
			maxPathSegments: expect.any(Number),
			maxArgs: expect.any(Number),
			maxRequestBytes: expect.any(Number),
		},
	})

	const call = await api.call('POST', '/v1/capability-proxy/call', {
		token: oauthToken,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(call.status).toBe(200)
	expect(JSON.stringify(call.body['result'])).toContain('api-user@example.com')

	const packageGraph = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token: oauthToken,
			body: {
				code: 'export default async function main() { return 1 }',
			},
		},
	)
	expect(packageGraph.status).toBe(200)
	expect(packageGraph.body).toEqual({
		modules: [],
		imports: [],
		warnings: [],
	})
})

test('MCP OAuth Bearer is rejected when local-execute flag is off', async () => {
	const oauthToken = 'cli-oauth-access-token-flag-off'
	const api = await createApi({
		localExecuteFlag: false,
		oauthAccessToken: oauthToken,
	})
	for (const [method, path, body] of [
		['GET', '/v1/capability-proxy/session', undefined],
		[
			'POST',
			'/v1/capability-proxy/call',
			{ path: ['kody', 'metaGetCurrentUser'], args: [{}] },
		],
		[
			'POST',
			'/v1/local-execute/package-graph',
			{ code: 'export default async function main() { return 1 }' },
		],
	] as const) {
		const response = await api.call(method, path, { token: oauthToken, body })
		expect(response.status).toBe(403)
		expect(response.body['error']).toMatchObject({
			code: 'feature_disabled',
			details: { feature_flag: 'local-execute' },
		})
	}
})

test('MCP OAuth Bearer is rejected unless it is a valid CLI token on a local-execute route', async () => {
	const invalid = await createApi({
		localExecuteFlag: true,
		oauthAccessToken: 'valid-oauth',
		oauthUnwrapFails: true,
	})
	const invalidResponse = await invalid.call(
		'GET',
		'/v1/capability-proxy/session',
		{ token: 'not-a-valid-oauth-or-api-token' },
	)
	expect(invalidResponse.status).toBe(401)
	expect(invalidResponse.body.error?.code).toBe('unauthorized')

	const oauthToken = 'cli-oauth-for-me-route'
	const localOnly = await createApi({
		localExecuteFlag: true,
		oauthAccessToken: oauthToken,
	})
	for (const path of ['/v1/me', '/v1/tokens'] as const) {
		const response = await localOnly.call('GET', path, { token: oauthToken })
		expect(response.status).toBe(401)
		expect(response.body.error?.message).toBe('Invalid API token.')
	}

	const wrongAudience = await createApi({
		localExecuteFlag: true,
		oauthAccessToken: 'cli-oauth-wrong-audience',
		oauthAudience: 'https://other.example/mcp',
	})
	expect(
		(
			await wrongAudience.call('GET', '/v1/capability-proxy/session', {
				token: 'cli-oauth-wrong-audience',
			})
		).status,
	).toBe(401)

	const nonCli = await createApi({
		localExecuteFlag: true,
		oauthAccessToken: 'host-mcp-oauth-not-cli',
		oauthClientId: 'https://cursor.com/oauth/callback-client',
	})
	expect(
		(
			await nonCli.call('GET', '/v1/capability-proxy/session', {
				token: 'host-mcp-oauth-not-cli',
			})
		).status,
	).toBe(401)
})
