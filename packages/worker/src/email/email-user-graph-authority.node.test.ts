import { expect, test } from 'vitest'
import {
	assertUserEmailGraphD1StatementsAllowedAfterCutover,
	classifyEmailGraphD1Statement,
} from '#worker/test-support/email-user-graph-statement-classifier.ts'
import {
	assertEmailGraphAuthority,
	assertSystemEmailGraphOwner,
	assertUserEmailGraphOwner,
	emailGraphAuthorityForOwner,
	emailUserGraphAuthority,
	systemEmailGraphAuthority,
} from './email-user-graph-authority.ts'
import { systemEmailOwnerId } from './email-owner.ts'

test('email graph authority reserves Mailbox for USER and dedicated D1 for system', () => {
	expect(emailGraphAuthorityForOwner('user-1')).toBe(emailUserGraphAuthority)
	expect(emailGraphAuthorityForOwner(systemEmailOwnerId)).toBe(
		systemEmailGraphAuthority,
	)
	expect(() =>
		assertEmailGraphAuthority({
			ownerId: 'user-1',
			authority: emailUserGraphAuthority,
		}),
	).not.toThrow()
	expect(() =>
		assertEmailGraphAuthority({
			ownerId: systemEmailOwnerId,
			authority: systemEmailGraphAuthority,
		}),
	).not.toThrow()
	expect(() =>
		assertEmailGraphAuthority({
			ownerId: 'user-1',
			authority: systemEmailGraphAuthority,
		}),
	).toThrow(/requires mailbox authority/iu)
	expect(() =>
		assertEmailGraphAuthority({
			ownerId: systemEmailOwnerId,
			authority: emailUserGraphAuthority,
		}),
	).toThrow(/requires dedicated-system-d1 authority/iu)
	expect(() => assertUserEmailGraphOwner(systemEmailOwnerId)).toThrow(
		/requires dedicated D1 graph authority/iu,
	)
	expect(() => assertSystemEmailGraphOwner('user-1')).toThrow(
		/require Mailbox authority/iu,
	)
})

test('test classifier rejects captured USER graph mutations but permits reads and provider lookup writes', () => {
	expect(
		classifyEmailGraphD1Statement(`
			WITH candidate AS (SELECT id FROM email_messages WHERE user_id = ?)
			DELETE FROM email_messages
			WHERE id IN (SELECT id FROM candidate)
		`),
	).toEqual({
		sharedGraphWrites: ['email_messages'],
		dedicatedSystemGraphWrites: [],
	})
	expect(
		classifyEmailGraphD1Statement(`
			INSERT INTO system_email_delivery_events (id) VALUES (?)
		`),
	).toEqual({
		sharedGraphWrites: [],
		dedicatedSystemGraphWrites: ['system_email_delivery_events'],
	})
	expect(
		classifyEmailGraphD1Statement(`
			-- UPDATE email_threads is commentary, not a statement.
			SELECT message.id
			FROM email_messages message
			WHERE message.user_id = ?
		`),
	).toEqual({
		sharedGraphWrites: [],
		dedicatedSystemGraphWrites: [],
	})

	expect(() =>
		assertUserEmailGraphD1StatementsAllowedAfterCutover({
			ownerId: 'user-1',
			statements: [
				`SELECT * FROM email_messages WHERE user_id = ?`,
				`INSERT INTO email_outbound_provider_index (
					provider, provider_message_id, user_id, message_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				`UPDATE users SET updated_at = ? WHERE stable_user_id = ?`,
			],
		}),
	).not.toThrow()
	expect(() =>
		assertUserEmailGraphD1StatementsAllowedAfterCutover({
			ownerId: 'user-1',
			statements: [
				`SELECT * FROM email_messages WHERE user_id = ?`,
				`UPDATE email_threads SET updated_at = ? WHERE id = ?`,
			],
		}),
	).toThrow(/D1 graph write to email_threads/iu)
	expect(() =>
		assertUserEmailGraphD1StatementsAllowedAfterCutover({
			ownerId: 'user-1',
			statements: [
				`REPLACE INTO "email_attachments" (id, message_id) VALUES (?, ?)`,
			],
		}),
	).toThrow(/D1 graph write to email_attachments/iu)
	expect(() =>
		assertUserEmailGraphD1StatementsAllowedAfterCutover({
			ownerId: systemEmailOwnerId,
			statements: [],
		}),
	).toThrow(/requires dedicated D1 graph authority/iu)
})
