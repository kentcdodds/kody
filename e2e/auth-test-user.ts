import { seedUserInE2eDatabase } from './d1-utils.ts'

export const primaryTestUser = {
	email: 'kody@example.com',
	username: 'kody',
	password: 'ilikecode',
}

/** Seed the primary test user straight into the local E2E D1 database. */
export async function ensurePrimaryUserExists() {
	await seedUserInE2eDatabase(primaryTestUser)
}
