import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	loadPersonalOrgIdForPerson,
	personalOrgIdForPerson,
	personalOrgIdFromUserRow,
} from './personal-org-id.ts'

const personId = 'a'.repeat(64)
const distinctOrgId = 'b'.repeat(64)

test('personalOrgIdFromUserRow prefers a stored personal org id', () => {
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: distinctOrgId,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: `  ${distinctOrgId}  `,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
})

test('personalOrgIdFromUserRow falls back to the person id while the column is empty', () => {
	for (const personalOrgIdValue of [null, undefined, '', '   ']) {
		expect(
			personalOrgIdFromUserRow({
				personal_org_id: personalOrgIdValue,
				stable_user_id: `  ${personId}  `,
			}),
		).toBe(personId)
	}
})

test('personalOrgIdForPerson prefers a stamped personalOrgId', () => {
	const userId = personIdFromStored(personId)
	expect(
		personalOrgIdForPerson({
			userId,
			personalOrgId: distinctOrgId as never,
		}),
	).toBe(distinctOrgId)
	expect(personalOrgIdForPerson({ userId })).toBe(userId)
})

test('loadPersonalOrgIdForPerson reads users.personal_org_id', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const equalPerson = personIdFromStored('c'.repeat(64))
	const distinctPerson = personIdFromStored(personId)
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (1, 'equal', 'equal@example.com', 'x', ?, ?),
			        (2, 'distinct', 'distinct@example.com', 'x', ?, ?)`,
		)
		.bind(equalPerson, equalPerson, distinctPerson, distinctOrgId)
		.run()
	expect(await loadPersonalOrgIdForPerson(db, equalPerson)).toBe(equalPerson)
	expect(await loadPersonalOrgIdForPerson(db, distinctPerson)).toBe(
		distinctOrgId,
	)
	expect(
		await loadPersonalOrgIdForPerson(db, personIdFromStored('d'.repeat(64))),
	).toBe(personIdFromStored('d'.repeat(64)))
})
