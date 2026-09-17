import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	lookupTransactionalEmailDelivery,
	transactionalEmailDestinationVerificationKind,
	transactionalEmailVerificationKind,
} from './verification-delivery.ts'

const sendCloudflareEmail = vi.fn(async () => ({
	ok: true,
	messageId: 'cf-destination-1',
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const { createEmailVerification } = await import('#app/email-verification.ts')
const {
	createEmailDestinationVerification,
	resendEmailDestinationVerification,
} = await import('./destination-verification.ts')

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(sqlite: DatabaseSync) {
	const stableUserId = await createStableUserIdFromEmail('owner@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1,
			'owner',
			'owner@example.com',
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			CURRENT_TIMESTAMP
		);
	`)
}

test('destination verify send indexes a distinct kind and leaves signup verification indexing alone', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as Env

	sendCloudflareEmail
		.mockResolvedValueOnce({
			ok: true,
			messageId: 'cf-destination-1',
		})
		.mockResolvedValueOnce({
			ok: true,
			messageId: 'cf-destination-2',
		})
		.mockResolvedValueOnce({
			ok: true,
			messageId: 'cf-signup-1',
		})

	const added = await createEmailDestinationVerification({
		env,
		userId: 1,
		email: 'pager@example.com',
		requestUrl: 'http://example.com',
	})
	expect(added.created).toBe(true)
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-destination-1',
		}),
	).toMatchObject({
		user_id: 1,
		kind: transactionalEmailDestinationVerificationKind,
		recipient: 'pager@example.com',
	})

	await resendEmailDestinationVerification({
		env,
		userId: 1,
		destinationId: added.destination.id,
		requestUrl: 'http://example.com',
	})
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-destination-1',
		}),
	).toBeNull()
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-destination-2',
		}),
	).toMatchObject({
		kind: transactionalEmailDestinationVerificationKind,
		recipient: 'pager@example.com',
	})

	await createEmailVerification({
		env,
		userId: 1,
		email: 'owner@example.com',
		requestUrl: 'http://example.com',
	})
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-signup-1',
		}),
	).toMatchObject({
		user_id: 1,
		kind: transactionalEmailVerificationKind,
		recipient: 'owner@example.com',
	})
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-destination-2',
		}),
	).toMatchObject({
		kind: transactionalEmailDestinationVerificationKind,
	})
	expect(
		sqlite
			.prepare(
				`SELECT kind FROM transactional_email_delivery_index
				 ORDER BY kind ASC`,
			)
			.all() as Array<{ kind: string }>,
	).toEqual([
		{ kind: transactionalEmailDestinationVerificationKind },
		{ kind: transactionalEmailVerificationKind },
	])
})
