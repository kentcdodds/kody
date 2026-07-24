import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminCommunityActivityListCapability } from './admin/admin-community-activity-list.ts'

const mocks = vi.hoisted(() => ({
	listCommunityActivityForAdmin: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityActivityForAdmin: mocks.listCommunityActivityForAdmin,
}))

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'actor-1',
				username: 'actor',
				email: 'actor@example.com',
				roles,
			},
		}),
	}
}

test('admin community activity list enforces admin role, filters, paginates, and returns only activity metadata', async () => {
	await expect(
		adminCommunityActivityListCapability.handler({}, createContext(['user'])),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.listCommunityActivityForAdmin).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mocks.listCommunityActivityForAdmin.mockResolvedValue({
		total: 3,
		page: 2,
		pageSize: 2,
		items: [
			{
				id: 'rating-1',
				kind: 'rating',
				listingId: 'listing-1',
				listingName: '@owner/package',
				listingKodyId: 'package',
				actingUsername: 'rater',
				occurredAt: '2026-07-20T01:00:00.000Z',
				stars: 5,
				adaptationEffort: 2,
			},
		],
	})

	const result = await adminCommunityActivityListCapability.handler(
		{
			page: 2,
			pageSize: 2,
			kind: 'rating',
			listing_id: 'listing-1',
		},
		createContext(['admin']),
	)

	expect(mocks.listCommunityActivityForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		page: 2,
		pageSize: 2,
		kind: 'rating',
		listingId: 'listing-1',
	})
	expect(result).toEqual({
		total: 3,
		page: 2,
		pageSize: 2,
		activity: [
			{
				id: 'rating-1',
				kind: 'rating',
				listing_id: 'listing-1',
				listing_name: '@owner/package',
				listing_kody_id: 'package',
				acting_username: 'rater',
				occurred_at: '2026-07-20T01:00:00.000Z',
				stars: 5,
				adaptation_effort: 2,
			},
		],
	})
	expect(result.activity[0]).not.toHaveProperty('note')
	expect(result.activity[0]).not.toHaveProperty('user_id')
	expect(result.activity[0]).not.toHaveProperty('package_source')
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'admin_community_activity_list:success',
	])
})
