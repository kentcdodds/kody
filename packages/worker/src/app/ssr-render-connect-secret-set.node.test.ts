import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { resetDataCacheForTests } from '#app/data-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const email = 'user@example.com'
const stableUserId = testStableUserIdFromEmail(email)

function createUserTestDb() {
	const userRow = {
		id: 1,
		email,
		username: 'account-user',
		password_hash: 'unused',
		stable_user_id: stableUserId,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
	const createStatement = (query: string, params: Array<unknown> = []) => {
		const isUserLookup =
			/^select[\s\S]*from "users"[\s\S]*"stable_user_id"\s*=/i.test(
				query.trim(),
			)
		const rows = isUserLookup && params[0] === stableUserId ? [userRow] : []
		return {
			query,
			bind: (...next: Array<unknown>) => createStatement(query, next),
			all: async () => ({
				results: rows,
				meta: { changes: 0, last_row_id: 0 },
			}),
			first: async () => rows[0] ?? null,
			run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
		}
	}
	return {
		prepare: (query: string) => createStatement(query),
		batch: (statements: Array<{ query?: string }>) =>
			executePreparedD1Batch(statements),
		exec: async () => undefined,
	} as unknown as D1Database
}

async function renderConnectSecretSet(query: string) {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{ stableUserId, email, rememberMe: false } satisfies AuthSession,
		false,
	)
	const response = await renderAppPage({
		request: new Request(`https://example.com/connect/secret-set?${query}`, {
			headers: { Cookie: cookie },
		}),
		env: {
			COOKIE_SECRET: testCookieSecret,
			SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
			...testOidcSigningEnv,
			APP_DB: createUserTestDb(),
			BUNDLE_ARTIFACTS_KV: {},
			JOB_MANAGER: {},
			STORAGE_RUNNER: {},
			PACKAGE_REALTIME_SESSION: {},
			MCP_CLIENT_HUB: {},
		} as unknown as Env,
		loaderData: {
			accountSecrets: {
				ok: true,
				email,
				packageOptions: [],
				packages: [],
				secrets: [],
				selectedSecret: null,
				approval: null,
				approvalError: null,
			},
		},
	})
	return { status: response.status, html: await response.text() }
}

function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('renderAppPage server-renders the dedicated connect-secret-set page', async () => {
	const named = await renderConnectSecretSet(
		'name=exampleApiKey&description=Example%20API%20key&allowedHosts=api.example.com&scope=user',
	)
	expect(named.status).toBe(200)
	expect(
		missing(named.html, [
			'data-testid="connect-secret-set"',
			'data-testid="connect-secret-set-card"',
			'exampleApiKey',
			'api.example.com',
		]),
	).toEqual([])
	// Named setup stays on the focused page, not the generic secrets list.
	expect(named.html).not.toContain('data-testid="account-secrets"')
	expect(named.html).not.toContain('data-testid="connect-secret-set-error"')

	const empty = await renderConnectSecretSet('')
	expect(empty.status).toBe(200)
	expect(empty.html).toContain('data-testid="connect-secret-set"')
	expect(empty.html).not.toContain('data-testid="connect-secret-set-card"')
})
