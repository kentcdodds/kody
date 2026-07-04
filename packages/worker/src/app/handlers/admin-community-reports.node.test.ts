import { expect, test, vi } from 'vitest'
import { createAdminCommunityReportsApiHandler } from './admin-community-reports.ts'
import { type CommunityReportRecord } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	getCommunityReportById: vi.fn(),
	resolveCommunityReport: vi.fn(),
	banCommunityUser: vi.fn(),
	listCommunityReports: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityReportById: (...args: Array<unknown>) =>
		mockModule.getCommunityReportById(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityReports: (...args: Array<unknown>) =>
		mockModule.listCommunityReports(...args),
	resolveCommunityReport: (...args: Array<unknown>) =>
		mockModule.resolveCommunityReport(...args),
	banCommunityUser: (...args: Array<unknown>) =>
		mockModule.banCommunityUser(...args),
}))

const sampleReport = {
	id: 'report-1',
	listingId: 'listing-1',
	listingName: '@owner/pkg',
	listingOwnerUserId: 'owner-mcp-id',
	reporterUserId: 'reporter-mcp-id',
	reason: 'Malware',
	status: 'open',
	resolvedByUserId: null,
	resolvedAt: null,
	resolutionNote: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies CommunityReportRecord

const adminActor = {
	mcpUser: { userId: 'admin-mcp-id' },
}

const env = { APP_DB: {} } as Env

test('admin community reports POST dispatches moderation intents', async () => {
	mockModule.requireUserWithRole.mockResolvedValue(adminActor)
	mockModule.getCommunityReportById.mockResolvedValue(sampleReport)
	mockModule.resolveCommunityReport.mockResolvedValue(undefined)
	mockModule.banCommunityUser.mockResolvedValue(undefined)

	const handler = createAdminCommunityReportsApiHandler(env)

	const dismiss = await handler.handler({
		request: new Request('https://example.com/admin/community-reports.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				intent: 'dismiss',
				reportId: 'report-1',
				note: 'Looks fine',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/community-reports.json'),
	} as never)
	expect(dismiss.status).toBe(200)
	expect(await dismiss.json()).toEqual({ ok: true })
	expect(mockModule.resolveCommunityReport).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		reportId: 'report-1',
		action: 'dismiss',
		resolutionNote: 'Looks fine',
	})
	expect(mockModule.banCommunityUser).not.toHaveBeenCalled()

	mockModule.resolveCommunityReport.mockClear()
	mockModule.banCommunityUser.mockClear()

	const banReporter = await handler.handler({
		request: new Request('https://example.com/admin/community-reports.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				intent: 'ban_reporter',
				reportId: 'report-1',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/community-reports.json'),
	} as never)
	expect(banReporter.status).toBe(200)
	expect(mockModule.banCommunityUser).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		userId: 'reporter-mcp-id',
		reason: 'Banned via community report moderation (report-1).',
	})
	expect(mockModule.resolveCommunityReport).not.toHaveBeenCalled()

	mockModule.banCommunityUser.mockClear()

	const banReportee = await handler.handler({
		request: new Request('https://example.com/admin/community-reports.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				intent: 'ban_reportee',
				reportId: 'report-1',
				note: 'Repeated abuse',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/community-reports.json'),
	} as never)
	expect(banReportee.status).toBe(200)
	expect(mockModule.banCommunityUser).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		userId: 'owner-mcp-id',
		reason: 'Repeated abuse',
	})

	mockModule.resolveCommunityReport.mockClear()

	await handler.handler({
		request: new Request('https://example.com/admin/community-reports.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				intent: 'delete',
				reportId: 'report-1',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/community-reports.json'),
	} as never)

	expect(mockModule.resolveCommunityReport).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		reportId: 'report-1',
		action: 'delete',
		resolutionNote: undefined,
	})
})
