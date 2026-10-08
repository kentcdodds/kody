import { expect, test } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { originWorkerHandler } from './origin-handler.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

type TokenPayload = {
	access_token: string
	refresh_token: string
}

const redirectUri = 'https://host.example/callback'
const resource = 'https://heykody.dev/mcp'

async function workerFetch(
	request: Request,
	workerEnv: Env = env,
): Promise<Response> {
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(request, workerEnv, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

function postForm(
	url: string | URL,
	data: Record<string, string>,
	{ json = false } = {},
) {
	return new Request(url, {
		method: 'POST',
		headers: {
			...(json ? { Accept: 'application/json' } : {}),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams(data),
	})
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
	const stableUserId = testStableUserIdFromEmail(email)
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
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
			}),
		}),
	)
	expect(registerResponse.status).toBe(201)
	const { client_id: clientId } = (await registerResponse.json()) as {
		client_id: string
	}
	const verifier = 'refresh-family-verifier-0123456789'
	const authorizeUrl = new URL('https://heykody.dev/oauth/authorize')
	authorizeUrl.search = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: 'profile email',
		code_challenge: await createS256CodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource,
		state: 'refresh-family-state',
	}).toString()

	const approvalResponse = await workerFetch(
		postForm(
			authorizeUrl,
			{ decision: 'approve', email, password },
			{ json: true },
		),
	)
	expect(approvalResponse.status).toBe(200)
	const { redirectTo } = (await approvalResponse.json()) as {
		redirectTo: string
	}
	const code = new URL(redirectTo).searchParams.get('code')
	expect(code).toBeTruthy()

	// Token requests run in a fresh isolate in production, so hide the
	// OAUTH_PROVIDER helpers the authorize handler injects onto the shared env.
	const isolatedEnv = new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'OAUTH_PROVIDER') return undefined
			return Reflect.get(target, prop, receiver)
		},
	}) as Env
	const tokenResponse = await workerFetch(
		postForm('https://heykody.dev/oauth/token', {
			grant_type: 'authorization_code',
			client_id: clientId,
			code: code ?? '',
			redirect_uri: redirectUri,
			code_verifier: verifier,
			resource,
		}),
		isolatedEnv,
	)
	expect(tokenResponse.status).toBe(200)
	const tokens = (await tokenResponse.json()) as TokenPayload
	expect(tokens.refresh_token).toBeTruthy()

	const refresh = async (refreshToken: string) => {
		const response = await workerFetch(
			postForm('https://heykody.dev/oauth/token', {
				grant_type: 'refresh_token',
				client_id: clientId,
				refresh_token: refreshToken,
				resource,
			}),
			isolatedEnv,
		)
		return {
			status: response.status,
			body: (await response.json()) as TokenPayload,
		}
	}
	return { rt1: tokens.refresh_token, refresh }
}

test('shared MCP OAuth client refresh reuse returns the current family token', async () => {
	const { rt1, refresh } = await mintSharedClientTokens()

	const [firstLeft, firstRight] = await Promise.all([
		refresh(rt1),
		refresh(rt1),
	])
	expect(firstLeft.status).toBe(200)
	expect(firstRight.status).toBe(200)
	expect(firstLeft.body.refresh_token).toBe(firstRight.body.refresh_token)
	expect(firstLeft.body.refresh_token).not.toBe(rt1)
	expect(firstLeft.body.access_token).toBe(firstRight.body.access_token)
	const rt2 = firstLeft.body.refresh_token

	const reused = await refresh(rt1)
	expect(reused.status).toBe(200)
	expect(reused.body.refresh_token).toBe(rt2)
	expect(reused.body.access_token).toBe(firstLeft.body.access_token)

	for (const concurrentReuse of await Promise.all([
		refresh(rt1),
		refresh(rt1),
	])) {
		expect(concurrentReuse.status).toBe(200)
		expect(concurrentReuse.body.refresh_token).toBe(rt2)
	}

	const currentStillWorks = await refresh(rt2)
	expect(currentStillWorks.status).toBe(200)
	expect(currentStillWorks.body.refresh_token).toBeTruthy()
	expect(currentStillWorks.body.refresh_token).not.toBe(rt1)
	expect(currentStillWorks.body.refresh_token).not.toBe(rt2)

	const staleSibling = await refresh(rt1)
	expect(staleSibling.status).toBe(400)
	expect(staleSibling.body).toMatchObject({ error: 'invalid_grant' })
})
