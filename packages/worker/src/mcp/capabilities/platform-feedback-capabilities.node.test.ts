import type * as PlatformFeedbackService from '#worker/platform-feedback/service.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { PlatformFeedbackInvalidTransitionError } from '#worker/platform-feedback/errors.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { adminPlatformFeedbackGetCapability } from './admin/admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin/admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin/admin-platform-feedback-update.ts'
import { platformFeedbackContentWarning } from './admin/platform-feedback-shared.ts'
import { metaPlatformFeedbackSubmitCapability } from './meta/meta-platform-feedback-submit.ts'

const mockModule = vi.hoisted(() => ({
	getPlatformFeedbackForAdmin: vi.fn(),
	listPlatformFeedbackForAdmin: vi.fn(),
	queueSend: vi.fn(),
	submitPlatformFeedback: vi.fn(),
	updatePlatformFeedbackForAdmin: vi.fn(),
}))

const synchronousFanOutModule = vi.hoisted(() => ({
	loaded: false,
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/platform-feedback/package-subscriptions.ts', () => {
	synchronousFanOutModule.loaded = true
	return {
		dispatchPlatformFeedbackSubmittedSubscriptionEvent:
			synchronousFanOutModule.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	}
})

vi.mock('#worker/platform-feedback/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PlatformFeedbackService>()
	return {
		...actual,
		getPlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.getPlatformFeedbackForAdmin(...args),
		listPlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.listPlatformFeedbackForAdmin(...args),
		submitPlatformFeedback: (...args: Array<unknown>) =>
			mockModule.submitPlatformFeedback(...args),
		updatePlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.updatePlatformFeedbackForAdmin(...args),
	}
})

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'user-1',
	submitterUsername: 'user-1-name',
	submitterEmail: 'user-1@example.com',
	category: 'friction' as const,
	summary: 'Setup is confusing',
	details: 'The setup flow does not explain the next action.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
}

function createCapabilityContext(input?: {
	userId?: string
	roles?: Array<string>
	packageId?: string
	executionOrigin?: 'interactive' | 'background'
}) {
	return {
		env: {
			APP_DB: {} as D1Database,
			PLATFORM_FEEDBACK_DISPATCH_QUEUE: {
				send: mockModule.queueSend,
			},
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			executionOrigin: input?.executionOrigin,
			storageContext:
				input?.packageId === undefined
					? undefined
					: { appId: 'package-app-1', packageId: input.packageId },
			...(input
				? {
						user: {
							userId: input.userId ?? 'user-1',
							username: `${input.userId ?? 'user-1'}-name`,
							email: `${input.userId ?? 'user-1'}@example.com`,
							roles: input.roles,
						},
					}
				: {}),
		}),
	}
}

test('meta platform feedback submission gates consent and isolates post-persistence enqueue failures', async () => {
	mockModule.submitPlatformFeedback.mockResolvedValue(openFeedback)
	const input = {
		category: 'friction' as const,
		summary: '  Setup is confusing  ',
		details: '  The setup flow does not explain the next action.  ',
		user_confirmed: true as const,
	}

	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext(),
		),
	).rejects.toThrow('Authenticated MCP user is required')
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			{ ...input, user_confirmed: false } as never,
			createCapabilityContext({ userId: 'user-1' }),
		),
	).rejects.toThrow()
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			{ ...input, metadata: { conversation: 'private' } } as never,
			createCapabilityContext({ userId: 'user-1' }),
		),
	).rejects.toThrow()
	expect(mockModule.submitPlatformFeedback).not.toHaveBeenCalled()
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext({ userId: 'user-1' }),
		),
	).rejects.toThrow(
		'only available from an interactive MCP agent flow after explicit user approval',
	)
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext({
				userId: 'user-1',
				executionOrigin: 'background',
			}),
		),
	).rejects.toThrow(
		'only available from an interactive MCP agent flow after explicit user approval',
	)
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext({
				userId: 'user-1',
				packageId: 'package-1',
				executionOrigin: 'interactive',
			}),
		),
	).rejects.toThrow(
		'only available from an interactive MCP agent flow after explicit user approval',
	)
	expect(mockModule.submitPlatformFeedback).not.toHaveBeenCalled()
	expect(mockModule.queueSend).not.toHaveBeenCalled()
	expect(synchronousFanOutModule.loaded).toBe(false)
	expect(
		synchronousFanOutModule.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).not.toHaveBeenCalled()

	mockModule.submitPlatformFeedback.mockRejectedValueOnce(
		new Error('active queue limit'),
	)
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext({
				userId: 'user-1',
				executionOrigin: 'interactive',
			}),
		),
	).rejects.toThrow('active queue limit')
	expect(mockModule.queueSend).not.toHaveBeenCalled()

	const result = await metaPlatformFeedbackSubmitCapability.handler(
		input,
		createCapabilityContext({
			userId: 'user-1',
			executionOrigin: 'interactive',
		}),
	)
	expect(mockModule.submitPlatformFeedback).toHaveBeenCalledWith({
		db: expect.anything(),
		submitterUserId: 'user-1',
		submitterUsername: 'user-1-name',
		submitterEmail: 'user-1@example.com',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
	})
	expect(mockModule.queueSend).toHaveBeenCalledWith({
		feedbackId: openFeedback.id,
	})
	expect(result).toEqual({
		feedback_id: 'feedback-1',
		status: 'open',
		created_at: '2026-07-19T00:00:00.000Z',
	})

	consoleError.mockImplementation(() => {})
	mockModule.queueSend.mockClear()
	mockModule.queueSend.mockRejectedValueOnce(new Error('Queue unavailable'))
	const resultAfterEnqueueFailure =
		await metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext({
				userId: 'user-1',
				executionOrigin: 'interactive',
			}),
		)
	expect(resultAfterEnqueueFailure).toEqual(result)
	expect(mockModule.queueSend).toHaveBeenCalledWith({
		feedbackId: openFeedback.id,
	})
	expect(consoleError).toHaveBeenCalledWith(
		'platform-feedback-dispatch-enqueue-failed',
		expect.any(Error),
	)
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(synchronousFanOutModule.loaded).toBe(false)
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('admin platform feedback capabilities enforce role access, redact lists, paginate, and audit', async () => {
	await expect(
		adminPlatformFeedbackListCapability.handler(
			{},
			createCapabilityContext({ userId: 'member-1', roles: ['user'] }),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mockModule.listPlatformFeedbackForAdmin).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mockModule.listPlatformFeedbackForAdmin.mockResolvedValue({
		total: 3,
		page: 2,
		pageSize: 1,
		items: [openFeedback],
	})
	mockModule.getPlatformFeedbackForAdmin.mockResolvedValue(openFeedback)
	const triagedFeedback = {
		...openFeedback,
		status: 'triaged' as const,
		reviewedByUserId: 'admin-1',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'Needs setup review.',
		updatedAt: '2026-07-19T01:00:00.000Z',
	}
	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValue(triagedFeedback)
	const adminContext = createCapabilityContext({
		userId: 'admin-1',
		roles: ['admin'],
	})

	const list = await adminPlatformFeedbackListCapability.handler(
		{ page: 2, pageSize: 1, status: 'open', category: 'friction' },
		adminContext,
	)
	expect(mockModule.listPlatformFeedbackForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		page: 2,
		pageSize: 1,
		status: 'open',
		category: 'friction',
	})
	expect(list).toMatchObject({
		total: 3,
		page: 2,
		pageSize: 1,
		content_warning: platformFeedbackContentWarning,
	})
	expect(list.feedback).toEqual([
		{
			id: 'feedback-1',
			submitter_user_id: 'user-1',
			category: 'friction',
			summary_untrusted: 'Setup is confusing',
			status: 'open',
			reviewed_by_user_id: null,
			reviewed_at: null,
			created_at: '2026-07-19T00:00:00.000Z',
			updated_at: '2026-07-19T00:00:00.000Z',
		},
	])
	expect(list.feedback[0]).not.toHaveProperty('summary')
	expect(list.feedback[0]).not.toHaveProperty('details')
	expect(list.feedback[0]).not.toHaveProperty('admin_note')

	const get = await adminPlatformFeedbackGetCapability.handler(
		{ id: 'feedback-1' },
		adminContext,
	)
	expect(get.feedback).toMatchObject({
		id: 'feedback-1',
		summary_untrusted: 'Setup is confusing',
		details_untrusted: 'The setup flow does not explain the next action.',
		admin_note: null,
	})
	expect(get.feedback).not.toHaveProperty('summary')
	expect(get.feedback).not.toHaveProperty('details')

	const updated = await adminPlatformFeedbackUpdateCapability.handler(
		{
			id: 'feedback-1',
			action: 'triage',
			admin_note: 'Needs setup review.',
		},
		adminContext,
	)
	expect(mockModule.updatePlatformFeedbackForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		feedbackId: 'feedback-1',
		reviewerUserId: 'admin-1',
		action: 'triage',
		adminNote: 'Needs setup review.',
	})
	expect(updated.feedback).toMatchObject({
		id: 'feedback-1',
		status: 'triaged',
		summary_untrusted: 'Setup is confusing',
		details_untrusted: 'The setup flow does not explain the next action.',
		reviewed_by_user_id: 'admin-1',
		admin_note: 'Needs setup review.',
	})
	expect(updated.content_warning).toBe(platformFeedbackContentWarning)
	mockModule.updatePlatformFeedbackForAdmin.mockRejectedValueOnce(
		new PlatformFeedbackInvalidTransitionError({
			feedbackId: 'feedback-1',
			status: 'resolved',
			action: 'dismiss',
		}),
	)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'dismiss' },
			adminContext,
		),
	).rejects.toThrow(
		'Cannot dismiss platform feedback "feedback-1" from status "resolved".',
	)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'admin_platform_feedback_list:success',
		'admin_platform_feedback_get:success',
		'admin_platform_feedback_update:success',
		'admin_platform_feedback_update:failure',
	])
})
