import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'
import { createAuthProviderStartHandler } from '#app/handlers/auth-provider.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { signupModeKvKey } from '#worker/signup-mode-setting.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

export const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

export type Handler = {
	handler(context: never): Promise<Response>
}

export function applyMigrations(db: DatabaseSync) {
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
}

export function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

export async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		stableUserId?: string
		emailVerified?: boolean
	},
) {
	const passwordHash = await createPasswordHash('test-password')
	const stableUserId =
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
	const verifiedAt = input.emailVerified ? 'CURRENT_TIMESTAMP' : 'NULL'
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			${verifiedAt}
		);
	`)
}

export function createAppEnv(
	db: D1Database,
	overrides: Record<string, unknown> = {},
): Env {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		SIGNUP_MODE: 'open',
		GITHUB_CLIENT_ID: 'github-client-id-test',
		GITHUB_CLIENT_SECRET: 'github-client-secret-test',
		GOOGLE_CLIENT_ID: 'google-client-id-test',
		GOOGLE_CLIENT_SECRET: 'google-client-secret-test',
		X_CLIENT_ID: 'x-client-id-test',
		X_CLIENT_SECRET: 'x-client-secret-test',
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
		...overrides,
	} as unknown as Env
}

export function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		store,
	} as unknown as KVNamespace
}

export function createSignupModeKv(mode: 'invite' | 'open' | 'waitlist') {
	return createMemoryKv({
		[signupModeKvKey]: JSON.stringify({
			mode,
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
}

export async function runHandler(
	handler: Handler,
	request: Request,
	params: Record<string, string> = {},
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params,
	} as never)
}

export function getCookiePair(setCookieHeader: string) {
	const pair = setCookieHeader.split(';')[0]
	if (!pair) throw new Error(`Unexpected Set-Cookie header: ${setCookieHeader}`)
	return pair
}

export async function startProviderFlow(
	env: Env,
	provider: string,
	url: string,
) {
	const startResponse = await runHandler(
		createAuthProviderStartHandler(env),
		new Request(url, { method: 'POST' }),
		{ provider },
	)
	expect(startResponse.status).toBe(302)
	const location = startResponse.headers.get('Location') ?? ''
	const stateCookie = getCookiePair(
		startResponse.headers.get('Set-Cookie') ?? '',
	)
	const state = new URL(location).searchParams.get('state') ?? ''
	return { location, stateCookie, state }
}
