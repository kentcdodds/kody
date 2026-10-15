import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as EmailSenderRules from '#worker/email/sender-rules.ts'
import {
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
} from '#worker/email/sender-rules.ts'

const mocks = vi.hoisted(() => ({
	listEmailSenderRules: vi.fn(),
	upsertEmailSenderRule: vi.fn(),
	deleteEmailSenderRule: vi.fn(),
}))

vi.mock('#worker/email/sender-rules.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailSenderRules>()
	return {
		...actual,
		listEmailSenderRules: mocks.listEmailSenderRules,
		upsertEmailSenderRule: mocks.upsertEmailSenderRule,
		deleteEmailSenderRule: mocks.deleteEmailSenderRule,
	}
})

const { emailSenderRuleListCapability } =
	await import('./email-sender-rule-list.ts')
const { emailSenderRuleSetCapability } =
	await import('./email-sender-rule-set.ts')
const { emailSenderRuleDeleteCapability } =
	await import('./email-sender-rule-delete.ts')

function createEnv() {
	return {
		APP_DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => ({
						email_verified_at: '2026-01-01T00:00:00.000Z',
					}),
				}),
			}),
		},
	} as unknown as Env
}

const personId = 'user-1'
const personalOrgId = 'org-distinct-1'

function createUserContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(personId),
			personalOrgId: ownerIdFromStored(personalOrgId),
			email: `${personId}@example.com`,
			displayName: 'User Example',
		},
	})
}

test('emailSenderRuleSet/list/delete scopes to the mailbox owner org and maps domain errors', async () => {
	const env = createEnv()
	const mailboxOwnerId = ownerIdFromStored(personalOrgId)
	const rule = {
		id: 'rule-1',
		userId: mailboxOwnerId,
		kind: 'domain' as const,
		value: 'spam.example',
		effect: 'block' as const,
		note: 'junk',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
	mocks.upsertEmailSenderRule.mockResolvedValueOnce(rule)
	mocks.listEmailSenderRules.mockResolvedValueOnce([rule])
	mocks.deleteEmailSenderRule.mockResolvedValueOnce(true)

	const setResult = await emailSenderRuleSetCapability.handler(
		{
			kind: 'domain',
			value: 'Spam.Example',
			effect: 'block',
			note: 'junk',
		},
		{ env, callerContext: createUserContext() },
	)
	expect(mocks.upsertEmailSenderRule).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: mailboxOwnerId,
		kind: 'domain',
		value: 'Spam.Example',
		effect: 'block',
		note: 'junk',
	})
	expect(setResult.rule).toEqual({
		id: 'rule-1',
		kind: 'domain',
		value: 'spam.example',
		effect: 'block',
		note: 'junk',
		created_at: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-01T00:00:00.000Z',
	})

	const listResult = await emailSenderRuleListCapability.handler(
		{},
		{ env, callerContext: createUserContext() },
	)
	expect(mocks.listEmailSenderRules).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: mailboxOwnerId,
	})
	expect(listResult.rules).toEqual([setResult.rule])

	const deleteResult = await emailSenderRuleDeleteCapability.handler(
		{ rule_id: 'rule-1' },
		{ env, callerContext: createUserContext() },
	)
	expect(mocks.deleteEmailSenderRule).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: mailboxOwnerId,
		ruleId: 'rule-1',
	})
	expect(deleteResult).toEqual({ deleted: true })

	// Domain errors become plain Error with the original message (not typed classes).
	mocks.upsertEmailSenderRule.mockRejectedValueOnce(
		new EmailSenderRuleValidationError('validation-failed'),
	)
	const validationError = await emailSenderRuleSetCapability
		.handler(
			{ kind: 'domain', value: 'not a domain', effect: 'block' },
			{ env, callerContext: createUserContext() },
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(validationError).toBeInstanceOf(Error)
	expect(validationError).not.toBeInstanceOf(EmailSenderRuleValidationError)
	expect((validationError as Error).message).toBe('validation-failed')

	mocks.upsertEmailSenderRule.mockRejectedValueOnce(
		new EmailSenderRuleLimitError('limit-reached'),
	)
	await expect(
		emailSenderRuleSetCapability.handler(
			{ kind: 'address', value: 'a@example.com', effect: 'allow' },
			{ env, callerContext: createUserContext() },
		),
	).rejects.toThrow('limit-reached')

	mocks.deleteEmailSenderRule.mockResolvedValueOnce(false)
	await expect(
		emailSenderRuleDeleteCapability.handler(
			{ rule_id: 'other-user-rule' },
			{ env, callerContext: createUserContext() },
		),
	).rejects.toThrow('Email sender rule not found: other-user-rule')
	expect(mocks.deleteEmailSenderRule).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		userId: mailboxOwnerId,
		ruleId: 'other-user-rule',
	})
})
