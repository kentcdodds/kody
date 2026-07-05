import { type APIRequestContext } from '@playwright/test'
import { seedUserInE2eDatabase } from './d1-utils.ts'

export const primaryTestUser = {
	email: 'kody@example.com',
	username: 'kody',
	password: 'ilikecode',
}

export async function ensurePrimaryUserExists(_request: APIRequestContext) {
	await seedUserInE2eDatabase(primaryTestUser)
}
