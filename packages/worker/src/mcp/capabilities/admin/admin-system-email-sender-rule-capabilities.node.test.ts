import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as EmailSenderRules from '#worker/email/sender-rules.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	listEmailSenderRules: vi.fn<typeof EmailSenderRules.listEmailSenderRules>(),
	upsertEmailSenderRule: vi.fn<typeof EmailSenderRules.upsertEmailSenderRule>(),
	deleteEmailSenderRule: vi.fn<typeof EmailSenderRules.deleteEmailSenderRule>(),
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

const { adminSystemEmailSenderRuleListCapability } =
	await import('./admin-system-email-sender-rule-list.ts')
const { adminSystemEmailSenderRuleSetCapability } =
	await import('./admin-system-email-sender-rule-set.ts')
const { adminSystemEmailSenderRuleDeleteCapability } =
	await import('./admin-system-email-sender-rule-delete.ts')

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'admin-user',
				username: 'admin',
				email: 'admin@example.com',
				roles,
			},
		}),
	}
}

test('admin system email sender rules require admin and operate on systemEmailOwnerId', async () => {
	await expect(
		adminSystemEmailSenderRuleListCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminSystemEmailSenderRuleSetCapability.handler(
			{ kind: 'domain', value: 'spam.example', effect: 'block' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminSystemEmailSenderRuleDeleteCapability.handler(
			{ rule_id: 'rule-1' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.listEmailSenderRules).not.toHaveBeenCalled()
	expect(mocks.upsertEmailSenderRule).not.toHaveBeenCalled()
	expect(mocks.deleteEmailSenderRule).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const rule = {
		id: 'system-rule-1',
		userId: systemEmailOwnerId,
		kind: 'address' as const,
		value: 'spammer@example.com',
		effect: 'quarantine' as const,
		note: '',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
	mocks.listEmailSenderRules.mockResolvedValueOnce([rule])
	mocks.upsertEmailSenderRule.mockResolvedValueOnce(rule)
	mocks.deleteEmailSenderRule.mockResolvedValueOnce(true)

	const ctx = createContext(['admin'])
	const list = await adminSystemEmailSenderRuleListCapability.handler({}, ctx)
	expect(mocks.listEmailSenderRules).toHaveBeenCalledWith({
		db: ctx.env.APP_DB,
		userId: systemEmailOwnerId,
	})
	expect(list).toEqual({
		ownerId: systemEmailOwnerId,
		rules: [
			{
				id: 'system-rule-1',
				kind: 'address',
				value: 'spammer@example.com',
				effect: 'quarantine',
				note: '',
				created_at: '2026-07-01T00:00:00.000Z',
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	const set = await adminSystemEmailSenderRuleSetCapability.handler(
		{
			kind: 'address',
			value: 'spammer@example.com',
			effect: 'quarantine',
		},
		ctx,
	)
	expect(mocks.upsertEmailSenderRule).toHaveBeenCalledWith({
		db: ctx.env.APP_DB,
		userId: systemEmailOwnerId,
		kind: 'address',
		value: 'spammer@example.com',
		effect: 'quarantine',
		note: undefined,
	})
	expect(set.ownerId).toBe(systemEmailOwnerId)
	expect(set.rule.id).toBe('system-rule-1')

	const deleted = await adminSystemEmailSenderRuleDeleteCapability.handler(
		{ rule_id: 'system-rule-1' },
		ctx,
	)
	expect(mocks.deleteEmailSenderRule).toHaveBeenCalledWith({
		db: ctx.env.APP_DB,
		userId: systemEmailOwnerId,
		ruleId: 'system-rule-1',
	})
	expect(deleted).toEqual({
		ownerId: systemEmailOwnerId,
		deleted: true,
	})

	expect(auditEventSummaries()).toEqual(
		expect.arrayContaining([
			'admin_system_email_sender_rule_list:success',
			'admin_system_email_sender_rule_set:success',
			'admin_system_email_sender_rule_delete:success',
		]),
	)
})
