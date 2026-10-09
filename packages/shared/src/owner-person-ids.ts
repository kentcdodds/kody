/**
 * Kody separates *whose data* an operation touches from *who* performs it.
 *
 * - `OwnerId` is the id of the org that owns a resource. It keys storage:
 *   `user_id` columns, Durable Object names, Vectorize metadata, R2/KV key
 *   prefixes, and secret AAD.
 * - `PersonId` identifies the acting person: sessions, passkeys,
 *   OAuth/CLI/API-token principals, audit actors, and RBAC.
 *
 * Every owner today is a person's personal org, whose id is that person's
 * `users.stable_user_id`. New accounts get a random id; legacy accounts may
 * hold SHA-256(email), so neither may ever be exposed publicly.
 * `personalOrgId` is the only conversion between the two, and mixing them is
 * a compile error. See docs/contributing/decisions/0060-owner-and-person-ids.md.
 */
import { toHex } from './hex.ts'

declare const ownerIdBrand: unique symbol
declare const personIdBrand: unique symbol

export type OwnerId = string & { readonly [ownerIdBrand]: true }
export type PersonId = string & { readonly [personIdBrand]: true }

type NotOwnerOrPerson<T> = T extends OwnerId | PersonId ? never : T

const stableIdPattern = /^[a-f0-9]{64}$/

function parseStableId(value: unknown) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return stableIdPattern.test(trimmed) ? trimmed : null
}

// Trims like the `users.stable_user_id` reads it replaced, so auth resolves
// existing rows exactly as before.
function requireStoredId(value: string | null | undefined, label: string) {
	const trimmed = value?.trim() ?? ''
	if (!trimmed) {
		throw new Error(`${label} is required`)
	}
	return trimmed
}

/**
 * Mint the id for a new account: 32 random bytes as 64 lowercase hex. Never
 * derive it from the email or any other attribute.
 */
export function mintPersonId(): PersonId {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes) as PersonId
}

/**
 * Parse an untrusted value (session record, admin input, request field) as a
 * person's stable id. Returns null unless it is 64 lowercase hex.
 */
export function parsePersonId<T>(value: NotOwnerOrPerson<T>): PersonId | null {
	return parseStableId(value) as PersonId | null
}

/**
 * Parse an untrusted value (admin input, request field) as an owner's stable
 * id. Returns null unless it is 64 lowercase hex.
 */
export function parseOwnerId<T>(value: NotOwnerOrPerson<T>): OwnerId | null {
	return parseStableId(value) as OwnerId | null
}

/**
 * Brand a person id read from Kody's own storage (a `users.stable_user_id`
 * row, a persisted caller context, a signed token claim). Throws when empty.
 */
export function personIdFromStored<T extends string | null | undefined>(
	value: NotOwnerOrPerson<T>,
): PersonId {
	return requireStoredId(value, 'Person id') as PersonId
}

/**
 * Brand an owner id read from Kody's own storage (a `user_id` /
 * `owner_user_id` column, an org id, a persisted owner). Throws
 * when empty. Owners are not always people: `system:email` owns system mail.
 */
export function ownerIdFromStored<T extends string | null | undefined>(
	value: NotOwnerOrPerson<T>,
): OwnerId {
	return requireStoredId(value, 'Owner id') as OwnerId
}

/**
 * The person's personal org: the owner their own actions read and write. A
 * personal org reuses the person's stable id, so this is the identity. Acting
 * in any other org must go through an explicit membership or grant check, never
 * through this function.
 */
export function personalOrgId(person: PersonId): OwnerId {
	return person as string as OwnerId
}
