import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	addEmailNotificationDestination,
	type EmailDestinationError,
	identityEmailDestinationId,
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
	reconcileDestinationsAfterIdentityEmailChange,
	removeEmailNotificationDestination,
	resolveAcceptableNotificationEmails,
	setDefaultEmailNotificationDestination,
	markEmailNotificationDestinationVerified,
} from './destinations.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function makeOwner() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const stableUserId = testStableUserIdFromEmail('owner@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1, 'owner', 'owner@example.com', ${quoteSqlString(stableUserId)},
			'test-password-hash', CURRENT_TIMESTAMP
		);
	`)
	const dbUserId = 1
	return {
		sqlite,
		db,
		add: (email: string) =>
			addEmailNotificationDestination({ db, dbUserId, email }),
		verify: (destinationId: string) =>
			markEmailNotificationDestinationVerified({
				db,
				destinationId,
				userId: dbUserId,
			}),
		setDefault: (destinationId: string) =>
			setDefaultEmailNotificationDestination({ db, dbUserId, destinationId }),
		remove: (destinationId: string) =>
			removeEmailNotificationDestination({ db, dbUserId, destinationId }),
		list: () => listEmailNotificationDestinations({ db, dbUserId }),
		resolve: () =>
			resolveAcceptableNotificationEmails({
				db,
				stableUserId,
				accountEmail: 'owner@example.com',
			}),
	}
}

test('identity is always listed, extras verify before they are sendable, and default can move off identity', async () => {
	const owner = await makeOwner()
	expect(await owner.list()).toEqual([
		{
			id: identityEmailDestinationId,
			email: 'owner@example.com',
			kind: 'identity',
			verified: true,
			isDefault: true,
			canRemove: false,
		},
	])

	const added = await owner.add('Phone@Example.com')
	expect(added.created).toBe(true)
	expect(added.destination).toMatchObject({
		email: 'phone@example.com',
		verified: false,
		isDefault: false,
		canRemove: true,
	})
	expect(await owner.add('phone@example.com')).toEqual({
		created: false,
		destination: added.destination,
	})

	const beforeVerify = await owner.resolve()
	expect([...beforeVerify.acceptable]).toEqual(['owner@example.com'])
	expect(beforeVerify.defaultEmail).toBe('owner@example.com')
	await expect(owner.setDefault(added.destination.id)).rejects.toMatchObject({
		code: 'not_verified',
	} satisfies Partial<EmailDestinationError>)

	expect((await owner.verify(added.destination.id))?.verified).toBe(true)
	await expect(owner.add('phone@example.com')).rejects.toMatchObject({
		code: 'already_added',
	} satisfies Partial<EmailDestinationError>)

	const afterDefault = await owner.setDefault(added.destination.id)
	expect(afterDefault.map((destination) => destination.isDefault)).toEqual([
		false,
		true,
	])
	const resolved = await owner.resolve()
	expect(resolved.acceptable).toEqual(
		new Set(['owner@example.com', 'phone@example.com']),
	)
	expect(resolved.defaultEmail).toBe('phone@example.com')

	const afterIdentityDefault = await owner.setDefault(
		identityEmailDestinationId,
	)
	expect(
		afterIdentityDefault.map((destination) => destination.isDefault),
	).toEqual([true, false])
	const afterRemove = await owner.remove(added.destination.id)
	expect(afterRemove.map((destination) => destination.isDefault)).toEqual([
		true,
	])
	await expect(owner.remove(identityEmailDestinationId)).rejects.toMatchObject({
		code: 'cannot_remove_identity',
	})
})

test('additional destinations cap at five extras and identity email cannot be added', async () => {
	const owner = await makeOwner()
	await expect(owner.add('owner@example.com')).rejects.toMatchObject({
		code: 'identity_email',
	})
	for (
		let index = 0;
		index < maxAdditionalEmailNotificationDestinations;
		index++
	) {
		expect((await owner.add(`extra-${index}@example.com`)).created).toBe(true)
	}
	await expect(owner.add('one-more@example.com')).rejects.toMatchObject({
		code: 'at_cap',
	})
	expect(await owner.list()).toHaveLength(
		1 + maxAdditionalEmailNotificationDestinations,
	)
})

test('display-name and odd email forms store the bare address and become sendable', async () => {
	const owner = await makeOwner()
	await expect(owner.add('Owner <owner@example.com>')).rejects.toMatchObject({
		code: 'identity_email',
	})
	const added = await owner.add('Phone <Phone@Example.com>')
	expect(added.created).toBe(true)
	expect(added.destination.email).toBe('phone@example.com')
	expect(
		owner.sqlite
			.prepare(`SELECT email FROM email_notification_destinations WHERE id = ?`)
			.get(added.destination.id) as { email: string },
	).toEqual({ email: 'phone@example.com' })

	await owner.verify(added.destination.id)
	owner.sqlite.exec(`
		INSERT INTO email_notification_destinations (
			id, user_id, email, verified_at, is_default
		) VALUES ('legacy-mixed-case', 1, 'Pager@Example.com', CURRENT_TIMESTAMP, 0);
	`)
	expect((await owner.resolve()).acceptable).toEqual(
		new Set(['owner@example.com', 'phone@example.com', 'pager@example.com']),
	)
})

test('changing identity email to an extra destination drops that extra row', async () => {
	const owner = await makeOwner()
	const added = await owner.add('next@example.com')
	await owner.verify(added.destination.id)
	await owner.setDefault(added.destination.id)

	await reconcileDestinationsAfterIdentityEmailChange({
		db: owner.db,
		userId: 1,
		newEmail: 'next@example.com',
	})
	expect(
		await listEmailNotificationDestinations({
			db: owner.db,
			dbUserId: 1,
			accountEmail: 'next@example.com',
			accountEmailVerified: true,
		}),
	).toEqual([
		{
			id: identityEmailDestinationId,
			email: 'next@example.com',
			kind: 'identity',
			verified: true,
			isDefault: true,
			canRemove: false,
		},
	])
})
