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

function createUsersDb(emailVerifiedAt: string | null) {
	return {
		prepare: () => ({
			bind: () => ({
				first: async () => ({ email_verified_at: emailVerifiedAt }),
			}),
		}),
	} as unknown as D1Database
}

function createEnv(options: { emailVerifiedAt?: string | null } = {}) {
	return {
		APP_DB: createUsersDb(
			options.emailVerifiedAt === undefined
				? '2026-01-01T00:00:00.000Z'
				: options.emailVerifiedAt,
		),
	} as Env
}

function createUserContext(userId = 'user-1') {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId,
			email: `${userId}@example.com`,
			displayName: 'User Example',
		},
	})
}

test('email_sender_rule_set/list/delete scopes to the caller and maps domain errors', async () => {
	const env = createEnv()
	const rule = {
		id: 'rule-1',
		userId: 'user-1',
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
		userId: 'user-1',
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
		userId: 'user-1',
	})
	expect(listResult.rules).toEqual([setResult.rule])

	const deleteResult = await emailSenderRuleDeleteCapability.handler(
		{ rule_id: 'rule-1' },
		{ env, callerContext: createUserContext() },
	)
	expect(mocks.deleteEmailSenderRule).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
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
			{ env, callerContext: createUserContext('user-1') },
		),
	).rejects.toThrow('Email sender rule not found: other-user-rule')
	expect(mocks.deleteEmailSenderRule).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
		ruleId: 'other-user-rule',
	})
})
