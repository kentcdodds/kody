import { test as base, expect, type APIRequestContext } from '@playwright/test'
import * as setCookieParser from 'set-cookie-parser'
import {
	assignRoleInE2eDatabase,
	clearAuthRateLimitsInE2eDatabase,
	seedUserInE2eDatabase,
} from './d1-utils.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { usernameFromEmail } from '../packages/worker/src/app/username.ts'

export * from '@playwright/test'

export const test = base.extend<{
	insertNewUser(options?: {
		email?: string
		username?: string
		password?: string
	}): Promise<{ email: string; username: string; password: string }>
	assignRole(email: string, role: string): Promise<void>
	seedE2eUser(options?: {
		email?: string
		username?: string
		password?: string
		admin?: boolean
	}): Promise<{ email: string; username: string; password: string }>
	login(options?: {
		email?: string
		username?: string
		password?: string
		mode?: 'login' | 'signup'
	}): Promise<{ email: string; username: string; password: string }>
}>({
	insertNewUser: async ({ page }, use) => {
		await use(async (options) => {
			const email = options?.email ?? primaryTestUser.email
			const username =
				options?.username ??
				(email === primaryTestUser.email
					? primaryTestUser.username
					: usernameFromEmail(email))
			const password = options?.password ?? primaryTestUser.password

			if (
				email === primaryTestUser.email &&
				password === primaryTestUser.password
			) {
				await ensurePrimaryUserExists()
				return { email, username: primaryTestUser.username, password }
			}

			clearAuthRateLimitsInE2eDatabase()
			await signupOrLoginViaAuth(page.request, { email, username, password })

			return { email, username, password }
		})
	},
	// Playwright fixtures require object destructuring even with no deps.
	// eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
	assignRole: async ({}, use) => {
		await use(async (email, role) => {
			assignRoleInE2eDatabase(email, role)
		})
	},
	// eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
	seedE2eUser: async ({}, use) => {
		await use(async (options) => {
			const runId = Date.now()
			const email = options?.email ?? `e2e-user-${runId}@example.com`
			const username = options?.username ?? `e2e-user-${runId}`
			const password = options?.password ?? 'e2e-test-password'
			await seedUserInE2eDatabase({
				email,
				username,
				password,
				admin: options?.admin,
			})
			return { email, username, password }
		})
	},
	login: async ({ page }, use) => {
		await use(async (options) => {
			const email = options?.email ?? primaryTestUser.email
			const username =
				options?.username ??
				(email === primaryTestUser.email
					? primaryTestUser.username
					: usernameFromEmail(email))
			const password = options?.password ?? primaryTestUser.password
			const preferredMode = options?.mode

			let response!: Awaited<ReturnType<typeof page.request.post>>
			await expect(async () => {
				clearAuthRateLimitsInE2eDatabase()
				if (preferredMode === 'login') {
					response = await page.request.post('/auth', {
						data: { email, password, mode: 'login' },
						headers: { 'Content-Type': 'application/json' },
					})
					if (!response.ok()) {
						throw new Error(
							`Failed to login user (${response.status()}): ${await readResponseDetail(response)}`,
						)
					}
					return
				}

				response = await signupOrLoginViaAuth(page.request, {
					email,
					username,
					password,
				})
			}).toPass({ timeout: 15_000 })

			// `page.request` already shares the browser context's cookie jar, so
			// the session cookie is registered for the 127.0.0.1 base URL by the
			// /auth response itself. This extra registration makes the same
			// session valid on `localhost` too, which the passkey specs need
			// because WebAuthn relying party ids must be domains, not IPs.
			const setCookieHeader = response.headers()['set-cookie']
			if (setCookieHeader) {
				const parsed = setCookieParser.parseString(setCookieHeader)
				const cookieConfig = {
					name: parsed.name,
					value: parsed.value,
					domain: 'localhost',
					path: parsed.path || '/',
					httpOnly: parsed.httpOnly,
					secure: parsed.secure,
					sameSite: parsed.sameSite as 'Strict' | 'Lax' | 'None',
				}
				await page.context().addCookies([cookieConfig])
			}

			return { email, username, password }
		})
	},
})

/**
 * Sign the user up via `/auth`, falling back to a login when the email is
 * already registered. Returns the response whose Set-Cookie header carries
 * the auth session.
 */
async function signupOrLoginViaAuth(
	request: APIRequestContext,
	credentials: { email: string; username: string; password: string },
) {
	const { email, username, password } = credentials
	const signupResponse = await request.post('/auth', {
		data: { email, username, password, mode: 'signup' },
		headers: { 'Content-Type': 'application/json' },
	})

	if (signupResponse.status() === 409) {
		const signupDetail = await readResponseDetail(signupResponse)
		if (signupDetail !== 'Email already registered.') {
			throw new Error(
				`Failed to seed user (${signupResponse.status()}): ${signupDetail}`,
			)
		}
		const loginResponse = await request.post('/auth', {
			data: { email, password, mode: 'login' },
			headers: { 'Content-Type': 'application/json' },
		})
		if (!loginResponse.ok()) {
			throw new Error(
				`Failed to login existing user (${loginResponse.status()}): ${await readResponseDetail(loginResponse)}`,
			)
		}
		return loginResponse
	}

	if (!signupResponse.ok()) {
		throw new Error(
			`Failed to seed user (${signupResponse.status()}): ${await readResponseDetail(signupResponse)}`,
		)
	}
	return signupResponse
}

async function readResponseDetail(response: { json(): Promise<unknown> }) {
	const payload = await response.json().catch(() => null)
	if (
		payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).error === 'string'
	) {
		return (payload as Record<string, string>).error
	}
	return 'Unknown error.'
}
