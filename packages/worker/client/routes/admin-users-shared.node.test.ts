import { expect, test } from 'vitest'

import { type AdminUserListItem } from '#universal/loader-data.ts'
import { roleNames } from '#universal/permissions.ts'
import { planNames } from '#universal/plans.ts'
import {
	nextAdminUsersWindowAfterCreate,
	nextAdminUsersWindowAfterMutation,
} from './admin-users-shared.ts'

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

function user(
	overrides: Partial<AdminUserListItem> & Pick<AdminUserListItem, 'username'>,
): AdminUserListItem {
	const id = overrides.stableUserId ?? stableUserId(1)
	return {
		stableUserId: id,
		email: `${overrides.username}@example.com`,
		email_verified: true,
		email_verified_at: '2026-01-01T00:00:00.000Z',
		plan: 'free',
		manualPlan: 'free',
		stripePlan: null,
		effectivePlan: 'free',
		entitlementLadder: 'public',
		stripeCustomerLinked: false,
		suspended_at: null,
		email_outbound_paused_at: null,
		email_verification_delivery: null,
		email_verification_delivery_detail: null,
		utm_source: null,
		utm_medium: null,
		utm_campaign: null,
		utm_content: null,
		utm_term: null,
		first_touch_landing_path: null,
		first_touch_referrer: null,
		first_mcp_connected_at: null,
		first_execute_at: null,
		first_search_at: null,
		first_saved_package_at: null,
		mcp_client_name: null,
		last_active_at: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		roles: ['user'],
		...overrides,
	}
}

test('create reseeds from the refreshed page; mutation cannot insert a new user', () => {
	const existing = user({
		stableUserId: stableUserId(1),
		username: 'existing',
	})
	const created = user({
		stableUserId: stableUserId(9),
		username: 'created',
	})
	const refreshedPage = {
		ok: true as const,
		users: [existing, created],
		selectedUser: null,
		page: 1,
		pageSize: 20,
		total: 2,
		availableRoles: [...roleNames],
		availablePlans: [...planNames],
		updatedUser: null,
	}

	const createdWindow = nextAdminUsersWindowAfterCreate(refreshedPage)
	expect(createdWindow.items.map((item) => item.username)).toEqual([
		'existing',
		'created',
	])
	expect(createdWindow.totalCount).toBe(2)
	expect(createdWindow.hasMore).toBe(false)

	const mutationWindow = nextAdminUsersWindowAfterMutation({
		currentItems: [existing],
		payload: {
			...refreshedPage,
			updatedUser: created,
			total: 2,
		},
		href: '/admin/users',
	})
	expect(mutationWindow.items.map((item) => item.username)).toEqual([
		'existing',
	])
	expect(mutationWindow.totalCount).toBe(2)

	const rolePatched = user({
		...existing,
		roles: ['user', 'admin'],
	})
	const patchedWindow = nextAdminUsersWindowAfterMutation({
		currentItems: [existing],
		payload: {
			...refreshedPage,
			users: [rolePatched],
			updatedUser: rolePatched,
			total: 1,
		},
		href: '/admin/users',
	})
	expect(patchedWindow.items).toEqual([rolePatched])
})
