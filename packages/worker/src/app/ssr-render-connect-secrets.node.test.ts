import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
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

function userSecret(name: string, allowedHosts: Array<string>) {
	return {
		id: `user:${name}`,
		name,
		scope: 'user' as const,
		description: '',
		packageId: null,
		packageTitle: null,
		allowedHosts,
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
	}
}

async function renderConnectSecrets(
	query: string,
	secret: ReturnType<typeof userSecret>,
	approval: {
		requestedHosts: Array<string>
		rejectedHosts?: Array<{
			host: string
			reason: 'malformed' | 'unknown_suffix'
			message: string
		}>
	},
) {
	invalidateCommunityPublicCache()
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{ stableUserId, email, rememberMe: false } satisfies AuthSession,
		false,
	)
	const response = await renderAppPage({
		request: new Request(`https://example.com/connect/secrets?${query}`, {
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
				secrets: [secret],
				selectedSecret: null,
				approval: {
					name: secret.name,
					names: [secret.name],
					scope: 'user',
					requestedHost: approval.requestedHosts[0]!,
					requestedHosts: approval.requestedHosts,
					rejectedHosts: approval.rejectedHosts ?? [],
					requestedPackageId: null,
					currentAllowedHosts: secret.allowedHosts,
					currentAllowedPackages: [],
				},
				approvalError: null,
			},
		},
	})
	return { status: response.status, html: await response.text() }
}

function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('renderAppPage server-renders the dedicated connect-secrets approval page', async () => {
	const { status, html } = await renderConnectSecrets(
		'name=googleAccessToken&hosts=gmail.googleapis.com,oauth2.googleapis.com',
		userSecret('googleAccessToken', ['oauth2.googleapis.com']),
		{ requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'] },
	)
	expect(status).toBe(200)
	expect(
		missing(html, [
			'data-testid="connect-secrets"',
			'gmail.googleapis.com',
			'oauth2.googleapis.com',
			'Allow all 2 hosts',
		]),
	).toEqual([])
	expect(html).not.toContain('New secret')
})

test('renderAppPage flags invalid connect-secrets hosts instead of offering Allow all', async () => {
	const { status, html } = await renderConnectSecrets(
		'names=slackWebhookPath,openaiApiKey&hosts=hooks.slack.com,api.ope',
		userSecret('openaiApiKey', []),
		{
			requestedHosts: ['hooks.slack.com'],
			rejectedHosts: [
				{
					host: 'api.ope',
					reason: 'unknown_suffix',
					message:
						"This host doesn't look complete (unknown public suffix). The approval link may have been truncated — copy it again.",
				},
			],
		},
	)
	expect(status).toBe(200)
	expect(
		missing(html, [
			'data-testid="connect-secrets"',
			'hooks.slack.com',
			'api.ope',
			'data-testid="connect-secrets-rejected-hosts"',
			'Allow access',
		]),
	).toEqual([])
	expect(html).not.toContain('Allow all 2 hosts')
})
