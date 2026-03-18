import { type APIRequestContext } from '@playwright/test'

export const primaryTestUser = {
	email: 'me@kentcdodds.com',
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

	if (response.status() !== 409) {
		throw new Error(`Failed to seed primary user (${response.status()}).`)
	}

	response = await request.post('/auth', {
		data: { ...primaryTestUser, mode: 'login' },
		headers: { 'Content-Type': 'application/json' },
	})

	if (!response.ok()) {
		throw new Error(
			`Primary user exists but could not log in (${response.status()}).`,
		)
	}
}
