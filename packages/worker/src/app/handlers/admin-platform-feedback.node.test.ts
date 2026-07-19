import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { platformFeedbackContentWarning } from '#worker/platform-feedback/content-warning.ts'
import { type AdminPlatformFeedbackLoaderData } from '#app/loader-data.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	loadAdminPlatformFeedbackData: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#app/admin-platform-feedback-data.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#app/admin-platform-feedback-data.ts')
		>()
	return {
		...actual,
		loadAdminPlatformFeedbackData: (...args: Array<unknown>) =>
			mockModule.loadAdminPlatformFeedbackData(...args),
	}
})

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#app/audit-log.ts')>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const listPayload = {
	ok: true,
	feedback: [],
	selectedFeedback: null,
	content_warning: platformFeedbackContentWarning,
	page: 1,
	pageSize: 20,
	total: 0,
	statusFilter: null,
	categoryFilter: null,
} satisfies AdminPlatformFeedbackLoaderData

const detailPayload = {
	...listPayload,
	selectedFeedback: {
		id: 'feedback-1',
		submitter_user_id: 'stable-submitter',
		submitter: {
			user_id: 'stable-submitter',
			username: 'submitter',
			email: 'submitter@example.com',
		},
		category: 'bug',
		summary_untrusted: 'A summary',
		details_untrusted: 'Full details',
		status: 'open',
		reviewed_by_user_id: null,
		reviewed_at: null,
		admin_note: null,
		created_at: '2026-07-19T00:00:00.000Z',
		updated_at: '2026-07-19T00:00:00.000Z',
	},
} satisfies AdminPlatformFeedbackLoaderData

const env = { APP_DB: {} } as Env

const { createAdminPlatformFeedbackApiHandler } =
	await import('./admin-platform-feedback.ts')

test('admin platform feedback JSON requires admin and audits list and detail reads', async () => {
	const handler = createAdminPlatformFeedbackApiHandler(env)
	const requestHandler = (search = '') =>
		handler.handler({
			request: new Request(
				`https://example.com/admin/platform-feedback.json${search}`,
				{ headers: { Accept: 'application/json' } },
			),
			params: {},
			url: new URL(`https://example.com/admin/platform-feedback.json${search}`),
		} as never)

	mockModule.requireUserWithRole.mockRejectedValueOnce(
		new Response(JSON.stringify({ ok: false, error: 'Forbidden.' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		}),
	)
	const forbidden = await requestHandler()
	expect(forbidden.status).toBe(403)
	expect(mockModule.requireUserWithRole).toHaveBeenCalledWith(
		expect.any(Request),
		env,
		'admin',
	)
	expect(mockModule.loadAdminPlatformFeedbackData).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()

	mockModule.requireUserWithRole.mockResolvedValue({
		email: 'admin@example.com',
	})
	mockModule.loadAdminPlatformFeedbackData.mockResolvedValueOnce(listPayload)
	const listResponse = await requestHandler()
	expect(listResponse.status).toBe(200)
	expect(await listResponse.json()).toEqual(listPayload)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'admin_platform_feedback_list',
			result: 'success',
			email: 'admin@example.com',
			ip: '127.0.0.1',
			path: '/admin/platform-feedback.json',
			reason: 'platform_feedback_list',
		}),
	)

	logAuditEventSpy.mockClear()
	mockModule.loadAdminPlatformFeedbackData.mockResolvedValueOnce(detailPayload)
	const detailResponse = await requestHandler('?feedbackId=feedback-1')
	expect(detailResponse.status).toBe(200)
	expect(await detailResponse.json()).toEqual(detailPayload)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'admin_platform_feedback_get',
			result: 'success',
			reason: 'feedback_id=feedback-1',
		}),
	)

	logAuditEventSpy.mockClear()
	mockModule.loadAdminPlatformFeedbackData.mockResolvedValueOnce(listPayload)
	const notFoundResponse = await requestHandler('?feedbackId=missing-feedback')
	expect(notFoundResponse.status).toBe(200)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'admin_platform_feedback_get',
			result: 'success',
			reason: 'feedback_id=missing-feedback;not_found',
		}),
	)

	logAuditEventSpy.mockClear()
	mockModule.loadAdminPlatformFeedbackData.mockResolvedValueOnce(listPayload)
	const unsafeId = `missing\n${'x'.repeat(300)}`
	await requestHandler(`?feedbackId=${encodeURIComponent(unsafeId)}`)
	const boundedReason = logAuditEventSpy.mock.calls[0]?.[0].reason
	expect(boundedReason).not.toContain('\n')
	expect(boundedReason?.endsWith(';not_found')).toBe(true)
	expect(boundedReason?.length).toBeLessThanOrEqual(222)
})
