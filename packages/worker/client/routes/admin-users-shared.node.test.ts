import { expect, test } from 'vitest'

import {
	createInfiniteList,
	type InfiniteListSnapshot,
} from '#client/infinite-list.ts'
import { type AdminUserListItem } from '#universal/loader-data.ts'
import { roleNames } from '#universal/permissions.ts'
import { planNames } from '#universal/plans.ts'
import {
	getListKey,
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

test('create reseeds from the refreshed page and prepends a user that paging omitted', () => {
	const existing = user({
		stableUserId: stableUserId(1),
		username: 'existing',
	})
	const created = user({
		stableUserId: stableUserId(9),
		username: 'created',
	})
	const basePayload = {
		ok: true as const,
		selectedUser: null,
		page: 1,
		pageSize: 20,
		availableRoles: [...roleNames],
		availablePlans: [...planNames],
		updatedUser: created,
	}

	const onPage = nextAdminUsersWindowAfterCreate({
		currentItems: [existing],
		currentHasMore: false,
		currentTotal: 1,
		payload: {
			...basePayload,
			users: [existing, created],
			total: 2,
			createdUserInFilteredList: true,
		},
	})
	expect(onPage.items.map((item) => item.username)).toEqual([
		'existing',
		'created',
	])
	expect(onPage.totalCount).toBe(2)
	expect(onPage.hasMore).toBe(false)

	const omittedFromPageOne = nextAdminUsersWindowAfterCreate({
		currentItems: [existing],
		currentHasMore: true,
		currentTotal: 20,
		payload: {
			...basePayload,
			users: [existing],
			total: 21,
			createdUserInFilteredList: true,
		},
	})
	expect(omittedFromPageOne.items.map((item) => item.username)).toEqual([
		'created',
		'existing',
	])
	expect(omittedFromPageOne.totalCount).toBe(21)
	expect(omittedFromPageOne.hasMore).toBe(true)

	// page * pageSize < total is still true (2 < 3) after prepending the
	// only omitted account; hasMore must follow the window length.
	const older = user({
		stableUserId: stableUserId(2),
		username: 'older',
	})
	const omittedLastRow = nextAdminUsersWindowAfterCreate({
		currentItems: [existing, older],
		currentHasMore: true,
		currentTotal: 2,
		payload: {
			...basePayload,
			pageSize: 2,
			users: [existing, older],
			total: 3,
			createdUserInFilteredList: true,
		},
	})
	expect(omittedLastRow.items.map((item) => item.username)).toEqual([
		'created',
		'existing',
		'older',
	])
	expect(omittedLastRow.totalCount).toBe(3)
	expect(omittedLastRow.hasMore).toBe(false)

	const refreshFailed = nextAdminUsersWindowAfterCreate({
		currentItems: [existing],
		currentHasMore: false,
		currentTotal: 1,
		payload: {
			...basePayload,
			users: [],
			total: 0,
			listRefreshFailed: true,
			createdUserInFilteredList: true,
		},
	})
	expect(refreshFailed.items.map((item) => item.username)).toEqual([
		'created',
		'existing',
	])
	expect(refreshFailed.totalCount).toBe(2)

	const excludedByFilter = nextAdminUsersWindowAfterCreate({
		currentItems: [existing],
		currentHasMore: false,
		currentTotal: 1,
		payload: {
			...basePayload,
			users: [existing],
			total: 1,
			createdUserInFilteredList: false,
		},
	})
	expect(excludedByFilter.items.map((item) => item.username)).toEqual([
		'existing',
	])
	expect(excludedByFilter.totalCount).toBe(1)

	const mutationWindow = nextAdminUsersWindowAfterMutation({
		currentItems: [existing],
		payload: {
			...basePayload,
			users: [existing],
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
			...basePayload,
			users: [rolePatched],
			updatedUser: rolePatched,
			total: 1,
		},
		href: '/admin/users',
	})
	expect(patchedWindow.items).toEqual([rolePatched])
})

test('failed create refresh keeps the current window when reset runs after the snapshot is read', () => {
	const existing = user({
		stableUserId: stableUserId(1),
		username: 'existing',
	})
	const created = user({
		stableUserId: stableUserId(9),
		username: 'created',
	})
	let snapshot: InfiniteListSnapshot<AdminUserListItem> = {
		items: [],
		hasMore: false,
		totalCount: 0,
		error: null,
		isLoadingInitial: false,
		isLoadingMore: false,
	}
	const list = createInfiniteList<AdminUserListItem>({
		mergeDirection: 'append',
		getKey: (item) => item.stableUserId,
		onSnapshot: (next) => {
			snapshot = next
		},
	})
	list.replaceWindow({
		items: [existing],
		hasMore: true,
		totalCount: 20,
	})
	const nextWindow = nextAdminUsersWindowAfterCreate({
		currentItems: snapshot.items,
		currentHasMore: snapshot.hasMore,
		currentTotal: snapshot.totalCount,
		payload: {
			ok: true,
			selectedUser: null,
			page: 1,
			pageSize: 20,
			availableRoles: [...roleNames],
			availablePlans: [...planNames],
			updatedUser: created,
			users: [],
			total: 0,
			listRefreshFailed: true,
			createdUserInFilteredList: true,
		},
	})
	list.reset()
	list.replaceWindow(nextWindow)
	expect(snapshot.items.map((item) => item.username)).toEqual([
		'created',
		'existing',
	])
	expect(snapshot.totalCount).toBe(21)
	expect(snapshot.hasMore).toBe(true)
})

test('selection refetch keeps a created user that page one omitted', () => {
	const oldest = user({
		stableUserId: stableUserId(1),
		username: 'oldest',
	})
	const older = user({
		stableUserId: stableUserId(2),
		username: 'older',
	})
	const created = user({
		stableUserId: stableUserId(9),
		username: 'created',
	})
	const pageOnePayload = {
		users: [oldest, older],
		page: 1,
		pageSize: 2,
		total: 3,
	}
	const afterCreate = nextAdminUsersWindowAfterCreate({
		currentItems: [oldest, older],
		currentHasMore: true,
		currentTotal: 2,
		payload: {
			ok: true,
			selectedUser: null,
			availableRoles: [...roleNames],
			availablePlans: [...planNames],
			updatedUser: created,
			createdUserInFilteredList: true,
			...pageOnePayload,
		},
	})
	expect(afterCreate.items.map((item) => item.username)).toEqual([
		'created',
		'oldest',
		'older',
	])
	expect(afterCreate.hasMore).toBe(false)

	const listKey = getListKey('/admin/users')
	// Selection changes the pathname (and route data) but not the list
	// filters, so applyPayload must keep the prepended created row.
	expect(getListKey(`/admin/users/${created.stableUserId}`)).toBe(listKey)
	expect(getListKey('/admin/users?role=admin')).not.toBe(listKey)
})
