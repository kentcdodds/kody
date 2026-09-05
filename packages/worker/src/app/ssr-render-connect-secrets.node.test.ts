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

function createUserTestDb() {
	function createStatement(query: string, params: Array<unknown> = []) {
		const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const executeAll = async () => {
			if (
				normalizedQuery.startsWith('select') &&
				normalizedQuery.includes('from "users"') &&
				/"stable_user_id"\s*=/.test(normalizedQuery)
			) {
				if (params[0] === testStableUserIdFromEmail('user@example.com')) {
					return {
						results: [
							{
								id: 1,
								email: 'user@example.com',
								username: 'account-user',
								password_hash: 'unused',
								stable_user_id: testStableUserIdFromEmail('user@example.com'),
								created_at: new Date(0).toISOString(),
								updated_at: new Date(0).toISOString(),
							},
						],
						meta: { changes: 0, last_row_id: 0 },
					}
				}
			}
			return {
				results: [],
				meta: { changes: 0, last_row_id: 0 },
			}
		}
		return {
			query,
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async all() {
				return executeAll()
			},
			async first() {
				const result = await executeAll()
				return result.results[0] ?? null
			},
			async run() {
				return { meta: { changes: 0, last_row_id: 0 } }
			},
		}
	}

	return {
		prepare(query: string) {
			return createStatement(query)
		},
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

test('renderAppPage server-renders the dedicated connect-secrets approval page', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: createUserTestDb(),
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
	} as unknown as Env
	const cookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)

	const connectSecretsResponse = await renderAppPage({
		request: new Request(
			'https://example.com/connect/secrets?name=googleAccessToken&hosts=gmail.googleapis.com,oauth2.googleapis.com',
			{ headers: { Cookie: cookie } },
		),
		env,
		loaderData: {
			accountSecrets: {
				ok: true,
				email: 'user@example.com',
				packageOptions: [],
				packages: [],
				secrets: [
					{
						id: 'user:googleAccessToken',
						name: 'googleAccessToken',
						scope: 'user',
						description: '',
						packageId: null,
						packageTitle: null,
						allowedHosts: ['oauth2.googleapis.com'],
						allowedPackages: [],
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						expiresAt: null,
						ttlMs: null,
					},
				],
				selectedSecret: null,
				approval: {
					name: 'googleAccessToken',
					names: ['googleAccessToken'],
					scope: 'user',
					requestedHost: 'gmail.googleapis.com',
					requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
					requestedPackageId: null,
					currentAllowedHosts: ['oauth2.googleapis.com'],
					currentAllowedPackages: [],
				},
				approvalError: null,
			},
		},
	})
	expect(connectSecretsResponse.status).toBe(200)
	const connectSecretsHtml = await connectSecretsResponse.text()
	expect(connectSecretsHtml).toContain('data-testid="connect-secrets"')
	expect(connectSecretsHtml).toContain('Allow this secret at these hosts')
	expect(connectSecretsHtml).toContain('gmail.googleapis.com')
	expect(connectSecretsHtml).toContain('oauth2.googleapis.com')
	expect(connectSecretsHtml).toContain('Allow all 2 hosts')
	expect(connectSecretsHtml).not.toContain('New secret')
})
