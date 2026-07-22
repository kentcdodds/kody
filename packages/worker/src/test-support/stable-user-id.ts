import { createHash } from 'node:crypto'

/**
 * Node-sync equivalent of `createStableUserIdFromEmail` for pure test mocks
 * that cannot await `crypto.subtle`. Matches signup/seed semantics.
 */
export function testStableUserIdFromEmail(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}
