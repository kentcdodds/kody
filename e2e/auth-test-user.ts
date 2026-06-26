import { type APIRequestContext } from '@playwright/test'

export const primaryTestUser = {
	email: 'kody@example.com',
	username: 'kody',
	password: 'iliketwix',
}

export async function ensurePrimaryUserExists(request: APIRequestContext) {
	let response = await request.post('/auth', {
		data: { ...primaryTestUser, mode: 'signup' },
		headers: { 'Content-Type': 'application/json' },
	})

	if (response.ok()) {
		return
	}

	if (response.status() === 429) {
		throw new Error(
			'Failed to seed primary user because /auth is rate-limited.',
		)
	}

	if (response.status() !== 409) {
		throw new Error(`Failed to seed primary user (${response.status()}).`)
	}
}
