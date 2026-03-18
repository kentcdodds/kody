import { test as base } from '@playwright/test'
import * as setCookieParser from 'set-cookie-parser'

export * from '@playwright/test'

export const test = base.extend<{
	insertNewUser(options?: {
		email?: string
		password?: string
	}): Promise<{ email: string; password: string }>
	login(options?: {
		email?: string
		password?: string
	}): Promise<{ email: string; password: string }>
}>({
	insertNewUser: async ({ page }, use) => {
		await use(async (options) => {
			const email = options?.email ?? `user-${crypto.randomUUID()}@example.com`
			const password = options?.password ?? 'password123'

			const response = await page.request.post('/auth', {
				data: { email, password, mode: 'signup' },
				headers: { 'Content-Type': 'application/json' },
			})

			if (!response.ok() && response.status() !== 409) {
				throw new Error(`Failed to seed user (${response.status()}).`)
			}

			return { email, password }
		})
	},
	login: async ({ page }, use) => {
		await use(async (options) => {
			const email = options?.email ?? `user-${crypto.randomUUID()}@example.com`
			const password = options?.password ?? 'password123'

			let response = await page.request.post('/auth', {
				data: { email, password, mode: 'signup' },
				headers: { 'Content-Type': 'application/json' },
			})

			if (!response.ok() && response.status() !== 409) {
				throw new Error(`Failed to seed user (${response.status()}).`)
			}

			if (response.status() === 409) {
				response = await page.request.post('/auth', {
					data: { email, password, mode: 'login' },
					headers: { 'Content-Type': 'application/json' },
				})

				if (!response.ok()) {
					throw new Error(`Failed to login user (${response.status()}).`)
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

			return { email, password }
		})
	},
})
