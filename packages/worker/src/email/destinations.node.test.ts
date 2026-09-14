import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	addEmailNotificationDestination,
	buildEmailDestinationsLoaderData,
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

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string; verified?: boolean },
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			${input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'}
		);
	`)
	return stableUserId
}

test('identity is always listed, extras verify before they are sendable, and default can move off identity', async () => {
	const { sqlite, db: appDb } = createMigratedDb()
	const userStableId = await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
	})

	const listed = await listEmailNotificationDestinations({
		db: appDb,
		dbUserId: 1,
	})
	expect(listed).toEqual([
		{
			id: identityEmailDestinationId,
			email: 'owner@example.com',
			kind: 'identity',
			verified: true,
			isDefault: true,
			canRemove: false,
		},
	])

	const added = await addEmailNotificationDestination({
		db: appDb,
		dbUserId: 1,
		email: 'Phone@Example.com',
	})
	expect(added.created).toBe(true)
	expect(added.destination).toMatchObject({
		email: 'phone@example.com',
		verified: false,
		isDefault: false,
		canRemove: true,
	})

	const beforeVerify = await resolveAcceptableNotificationEmails({
		db: appDb,
		stableUserId: userStableId,
		accountEmail: 'owner@example.com',
	})
	expect([...beforeVerify.acceptable]).toEqual(['owner@example.com'])
	expect(beforeVerify.defaultEmail).toBe('owner@example.com')

	await expect(
		setDefaultEmailNotificationDestination({
			db: appDb,
			dbUserId: 1,
			destinationId: added.destination.id,
		}),
	).rejects.toMatchObject({
		code: 'not_verified',
	} satisfies Partial<EmailDestinationError>)

	const verified = await markEmailNotificationDestinationVerified({
		db: appDb,
		destinationId: added.destination.id,
		userId: 1,
	})
	expect(verified?.verified).toBe(true)

	const afterDefault = await setDefaultEmailNotificationDestination({
		db: appDb,
		dbUserId: 1,
		destinationId: added.destination.id,
	})
	expect(afterDefault.map((destination) => destination.isDefault)).toEqual([
		false,
		true,
	])

	const resolved = await resolveAcceptableNotificationEmails({
		db: appDb,
		stableUserId: userStableId,
		accountEmail: 'owner@example.com',
	})
	expect(resolved.acceptable).toEqual(
		new Set(['owner@example.com', 'phone@example.com']),
	)
	expect(resolved.defaultEmail).toBe('phone@example.com')

	const afterIdentityDefault = await setDefaultEmailNotificationDestination({
		db: appDb,
		dbUserId: 1,
		destinationId: identityEmailDestinationId,
	})
	expect(afterIdentityDefault[0]?.isDefault).toBe(true)
	expect(afterIdentityDefault[1]?.isDefault).toBe(false)

	const afterRemove = await removeEmailNotificationDestination({
		db: appDb,
		dbUserId: 1,
		destinationId: added.destination.id,
	})
	expect(afterRemove).toHaveLength(1)
	expect(afterRemove[0]?.isDefault).toBe(true)

	await expect(
		removeEmailNotificationDestination({
			db: appDb,
			dbUserId: 1,
			destinationId: identityEmailDestinationId,
		}),
	).rejects.toMatchObject({ code: 'cannot_remove_identity' })
})

test('additional destinations cap at five extras and identity email cannot be added', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
	})

	await expect(
		addEmailNotificationDestination({
			db,
			dbUserId: 1,
			email: 'owner@example.com',
		}),
	).rejects.toMatchObject({ code: 'identity_email' })

	for (
		let index = 0;
		index < maxAdditionalEmailNotificationDestinations;
		index++
	) {
		const added = await addEmailNotificationDestination({
			db,
			dbUserId: 1,
			email: `extra-${index}@example.com`,
		})
		expect(added.created).toBe(true)
	}

	await expect(
		addEmailNotificationDestination({
			db,
			dbUserId: 1,
			email: 'one-more@example.com',
		}),
	).rejects.toMatchObject({ code: 'at_cap' })

	const listed = await listEmailNotificationDestinations({
		db,
		dbUserId: 1,
	})
	expect(listed).toHaveLength(1 + maxAdditionalEmailNotificationDestinations)
})

test('display-name and odd email forms store the bare address and become sendable', async () => {
	const { sqlite, db } = createMigratedDb()
	const userStableId = await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
	})

	await expect(
		addEmailNotificationDestination({
			db,
			dbUserId: 1,
			email: 'Owner <owner@example.com>',
		}),
	).rejects.toMatchObject({ code: 'identity_email' })

	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'Phone <Phone@Example.com>',
	})
	expect(added.created).toBe(true)
	expect(added.destination.email).toBe('phone@example.com')
	expect(
		sqlite
			.prepare(`SELECT email FROM email_notification_destinations WHERE id = ?`)
			.get(added.destination.id) as { email: string },
	).toEqual({ email: 'phone@example.com' })

	await markEmailNotificationDestinationVerified({
		db,
		destinationId: added.destination.id,
		userId: 1,
	})
	sqlite.exec(`
		INSERT INTO email_notification_destinations (
			id, user_id, email, verified_at, is_default
		) VALUES (
			'legacy-mixed-case',
			1,
			'Pager@Example.com',
			CURRENT_TIMESTAMP,
			0
		);
	`)
	const resolved = await resolveAcceptableNotificationEmails({
		db,
		stableUserId: userStableId,
		accountEmail: 'owner@example.com',
	})
	expect(resolved.acceptable).toEqual(
		new Set(['owner@example.com', 'phone@example.com', 'pager@example.com']),
	)
})

test('changing identity email to an extra destination drops that extra row', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
	})
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'next@example.com',
	})
	await markEmailNotificationDestinationVerified({
		db,
		destinationId: added.destination.id,
		userId: 1,
	})
	await setDefaultEmailNotificationDestination({
		db,
		dbUserId: 1,
		destinationId: added.destination.id,
	})

	await reconcileDestinationsAfterIdentityEmailChange({
		db,
		userId: 1,
		newEmail: 'next@example.com',
	})

	const listed = await listEmailNotificationDestinations({
		db,
		dbUserId: 1,
		accountEmail: 'next@example.com',
		accountEmailVerified: true,
	})
	expect(listed).toEqual([
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

test('destinations loader data counts remaining extras against the cap', () => {
	const identity = {
		id: identityEmailDestinationId,
		email: 'owner@example.com',
		kind: 'identity' as const,
		verified: true,
		isDefault: true,
		canRemove: false,
	}
	const extra = {
		id: 'dest-1',
		email: 'pager@example.com',
		kind: 'additional' as const,
		verified: false,
		isDefault: false,
		canRemove: true,
	}
	expect(buildEmailDestinationsLoaderData([identity, extra])).toEqual({
		ok: true,
		destinations: [identity, extra],
		additionalLimit: maxAdditionalEmailNotificationDestinations,
		additionalRemaining: maxAdditionalEmailNotificationDestinations - 1,
	})
})
