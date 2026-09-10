import { expect, test } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

type TokenPayload = {
	access_token: string
	refresh_token: string
	token_type: string
	expires_in: number
	scope?: string
	resource?: string
}

async function workerFetch(
	request: Request,
	workerEnv: Env = env,
): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, workerEnv, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

async function createS256CodeChallenge(verifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	)
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

async function seedWorkerUser(email: string, password: string) {
	const passwordHash = await createPasswordHash(password)
	const stableUserId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			email_verified_at TEXT,
			stable_user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN stable_user_id TEXT`,
		).run()
	} catch {
		// Column already present on a fresh CREATE above.
	}
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS verifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			type TEXT NOT NULL,
			target TEXT NOT NULL,
			secret TEXT NOT NULL,
			algorithm TEXT NOT NULL,
			digits INTEGER NOT NULL,
			period INTEGER NOT NULL,
			char_set TEXT NOT NULL,
			expires_at INTEGER,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			UNIQUE (target, type)
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(email) DO UPDATE SET
				password_hash = excluded.password_hash,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id)`,
	)
		.bind(
			`user-${crypto.randomUUID().slice(0, 8)}`,
			email,
			passwordHash,
			new Date(0).toISOString(),
			stableUserId,
		)
		.run()
}

function tokenEnv() {
	return new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'OAUTH_PROVIDER') return undefined
			return Reflect.get(target, prop, receiver)
		},
	}) as Env
}

async function exchangeRefreshToken(
	clientId: string,
	refreshToken: string,
	workerEnv: Env,
) {
	const response = await workerFetch(
		new Request('https://heykody.dev/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				client_id: clientId,
				refresh_token: refreshToken,
				resource: 'https://heykody.dev/mcp',
			}),
		}),
		workerEnv,
	)
	return response
}

async function mintSharedClientTokens() {
	const email = `refresh-family-${crypto.randomUUID()}@example.com`
	const password = 'password123'
	await seedWorkerUser(email, password)

	const registerResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Concurrent MCP host',
				redirect_uris: ['https://host.example/callback'],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
			}),
		}),
	)
	expect(registerResponse.status).toBe(201)
	const registered = (await registerResponse.json()) as { client_id: string }
	const verifier = 'refresh-family-verifier-0123456789'
	const authorizeUrl = new URL('https://heykody.dev/oauth/authorize')
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', registered.client_id)
	authorizeUrl.searchParams.set('redirect_uri', 'https://host.example/callback')
	authorizeUrl.searchParams.set('scope', 'profile email')
	authorizeUrl.searchParams.set(
		'code_challenge',
		await createS256CodeChallenge(verifier),
	)
	authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	authorizeUrl.searchParams.set('resource', 'https://heykody.dev/mcp')
	authorizeUrl.searchParams.set('state', 'refresh-family-state')

	const approvalResponse = await workerFetch(
		new Request(authorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				decision: 'approve',
				email,
				password,
			}),
		}),
	)
	expect(approvalResponse.status).toBe(200)
	const approvalPayload = (await approvalResponse.json()) as {
		redirectTo: string
	}
	const code = new URL(approvalPayload.redirectTo).searchParams.get('code')
	expect(code).toBeTruthy()

	const isolatedEnv = tokenEnv()
	const tokenResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: registered.client_id,
				code: code ?? '',
				redirect_uri: 'https://host.example/callback',
				code_verifier: verifier,
				resource: 'https://heykody.dev/mcp',
			}),
		}),
		isolatedEnv,
	)
	expect(tokenResponse.status).toBe(200)
	const tokens = (await tokenResponse.json()) as TokenPayload
	expect(tokens.refresh_token).toBeTruthy()
	return {
		clientId: registered.client_id,
		tokens,
		env: isolatedEnv,
	}
}

test('shared MCP OAuth client refresh reuse returns the current family token', async () => {
	const {
		clientId,
		tokens: first,
		env: isolatedEnv,
	} = await mintSharedClientTokens()
	const rt1 = first.refresh_token

	const firstRefresh = await exchangeRefreshToken(clientId, rt1, isolatedEnv)
	expect(firstRefresh.status).toBe(200)
	const afterRt1 = (await firstRefresh.json()) as TokenPayload
	const rt2 = afterRt1.refresh_token
	expect(rt2).not.toBe(rt1)

	const reusedRt1 = await exchangeRefreshToken(clientId, rt1, isolatedEnv)
	expect(reusedRt1.status).toBe(200)
	const reused = (await reusedRt1.json()) as TokenPayload
	expect(reused.refresh_token).toBe(rt2)
	expect(reused.access_token).toBe(afterRt1.access_token)

	const [left, right] = await Promise.all([
		exchangeRefreshToken(clientId, rt1, isolatedEnv),
		exchangeRefreshToken(clientId, rt1, isolatedEnv),
	])
	expect(left.status).toBe(200)
	expect(right.status).toBe(200)
	const leftTokens = (await left.json()) as TokenPayload
	const rightTokens = (await right.json()) as TokenPayload
	expect(leftTokens.refresh_token).toBe(rt2)
	expect(rightTokens.refresh_token).toBe(rt2)

	const currentStillWorks = await exchangeRefreshToken(
		clientId,
		rt2,
		isolatedEnv,
	)
	expect(currentStillWorks.status).toBe(200)
	const afterRt2 = (await currentStillWorks.json()) as TokenPayload
	expect(afterRt2.refresh_token).toBeTruthy()
	expect(afterRt2.refresh_token).not.toBe(rt1)
	expect(afterRt2.refresh_token).not.toBe(rt2)

	const staleSibling = await exchangeRefreshToken(clientId, rt1, isolatedEnv)
	expect(staleSibling.status).toBe(400)
	await expect(staleSibling.json()).resolves.toMatchObject({
		error: 'invalid_grant',
	})
})
