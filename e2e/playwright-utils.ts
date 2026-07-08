import { test as base } from '@playwright/test'
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
				await ensurePrimaryUserExists(page.request)
				return { email, username: primaryTestUser.username, password }
			}

			clearAuthRateLimitsInE2eDatabase()
			const response = await page.request.post('/auth', {
				data: { email, username, password, mode: 'signup' },
				headers: { 'Content-Type': 'application/json' },
			})

			if (response.status() === 409) {
				const detail = await readResponseDetail(response)
				if (detail !== 'Email already registered.') {
					throw new Error(
						`Failed to seed user (${response.status()}): ${detail}`,
					)
				}
				const loginResponse = await page.request.post('/auth', {
					data: { email, password, mode: 'login' },
					headers: { 'Content-Type': 'application/json' },
				})
				if (!loginResponse.ok()) {
					throw new Error(
						`Failed to seed user (${response.status()}): ${detail}`,
					)
				}
			} else if (!response.ok()) {
				throw new Error(
					`Failed to seed user (${response.status()}): ${await readResponseDetail(response)}`,
				)
			}

			return { email, username, password }
		})
	},
	assignRole: async ({}, use) => {
		await use(async (email, role) => {
			assignRoleInE2eDatabase(email, role)
		})
	},
	seedE2eUser: async ({}, use) => {
		await use(async (options) => {
			const runId = Date.now()
			const email = options?.email ?? `e2e-user-${runId}@example.com`
			const username = options?.username ?? `e2e-user-${runId}`
			const password = options?.password ?? 'e2e-test-password'
			await seedUserInE2eDatabase({ email, username, password })
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

			clearAuthRateLimitsInE2eDatabase()
			let response: Awaited<ReturnType<typeof page.request.post>>
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
			} else {
				response = await page.request.post('/auth', {
					data: { email, username, password, mode: 'signup' },
					headers: { 'Content-Type': 'application/json' },
				})

				if (response.status() === 409) {
					const detail = await readResponseDetail(response)
					if (detail !== 'Email already registered.') {
						throw new Error(
							`Failed to seed user (${response.status()}): ${detail}`,
						)
					}
					response = await page.request.post('/auth', {
						data: { email, password, mode: 'login' },
						headers: { 'Content-Type': 'application/json' },
					})

					if (!response.ok()) {
						throw new Error(
							`Failed to login user (${response.status()}): ${await readResponseDetail(response)}`,
						)
					}
				} else if (!response.ok()) {
					throw new Error(
						`Failed to seed user (${response.status()}): ${await readResponseDetail(response)}`,
					)
				}
			}

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
