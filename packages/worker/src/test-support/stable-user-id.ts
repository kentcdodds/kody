import { createHash } from 'node:crypto'

/**
 * Deterministic fixture id for seeding test accounts by email. Production mints
 * random ids (`mintPersonId`); this matches the legacy email-hash shape so
 * tests can also seed pre-random-id accounts.
 */
export function testStableUserIdFromEmail(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}
