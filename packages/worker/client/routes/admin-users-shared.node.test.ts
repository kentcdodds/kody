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

function user(id: number, username: string): AdminUserListItem {
	return {
		stableUserId: id.toString(16).padStart(64, '0'),
		username,
		email: `${username}@example.com`,
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
	}
}

const existing = user(1, 'existing')
const older = user(2, 'older')
const created = user(9, 'created')

type CreatePayload = Parameters<
	typeof nextAdminUsersWindowAfterCreate
>[0]['payload']

const payload = (
	users: Array<AdminUserListItem>,
	total: number,
	overrides: Partial<CreatePayload> = {},
): CreatePayload => ({
	ok: true,
	selectedUser: null,
	page: 1,
	pageSize: 20,
	availableRoles: [...roleNames],
	availablePlans: [...planNames],
	updatedUser: created,
	createdUserInFilteredList: true,
	users,
	total,
	...overrides,
})

const summarize = (window: {
	items: Array<AdminUserListItem>
	totalCount: number
	hasMore: boolean
}) => ({
	names: window.items.map((item) => item.username),
	totalCount: window.totalCount,
	hasMore: window.hasMore,
})

test('create reseeds from the refreshed page and prepends a user that paging omitted', () => {
	const afterCreate = (
		currentItems: Array<AdminUserListItem>,
		currentHasMore: boolean,
		currentTotal: number,
		next: CreatePayload,
	) =>
		summarize(
			nextAdminUsersWindowAfterCreate({
				currentItems,
				currentHasMore,
				currentTotal,
				payload: next,
			}),
		)

	expect(
		afterCreate([existing], false, 1, payload([existing, created], 2)),
	).toEqual({ names: ['existing', 'created'], totalCount: 2, hasMore: false })
	expect(afterCreate([existing], true, 20, payload([existing], 21))).toEqual({
		names: ['created', 'existing'],
		totalCount: 21,
		hasMore: true,
	})
	// page * pageSize < total is still true (2 < 3) after prepending the
	// only omitted account; hasMore must follow the window length.
	expect(
		afterCreate(
			[existing, older],
			true,
			2,
			payload([existing, older], 3, { pageSize: 2 }),
		),
	).toEqual({
		names: ['created', 'existing', 'older'],
		totalCount: 3,
		hasMore: false,
	})
	expect(
		afterCreate(
			[existing],
			false,
			1,
			payload([], 0, { listRefreshFailed: true }),
		),
	).toMatchObject({ names: ['created', 'existing'], totalCount: 2 })
	expect(
		afterCreate(
			[existing],
			false,
			1,
			payload([existing], 1, { createdUserInFilteredList: false }),
		),
	).toMatchObject({ names: ['existing'], totalCount: 1 })

	const mutationWindow = nextAdminUsersWindowAfterMutation({
		currentItems: [existing],
		payload: payload([existing], 2),
		href: '/admin/users',
	})
	expect(mutationWindow.items.map((item) => item.username)).toEqual([
		'existing',
	])
	expect(mutationWindow.totalCount).toBe(2)

	const rolePatched: AdminUserListItem = {
		...existing,
		roles: ['user', 'admin'],
	}
	const patchedWindow = nextAdminUsersWindowAfterMutation({
		currentItems: [existing],
		payload: payload([rolePatched], 1, { updatedUser: rolePatched }),
		href: '/admin/users',
	})
	expect(patchedWindow.items).toEqual([rolePatched])
})

test('failed create refresh keeps the current window when reset runs after the snapshot is read', () => {
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
	list.replaceWindow({ items: [existing], hasMore: true, totalCount: 20 })
	const nextWindow = nextAdminUsersWindowAfterCreate({
		currentItems: snapshot.items,
		currentHasMore: snapshot.hasMore,
		currentTotal: snapshot.totalCount,
		payload: payload([], 0, { listRefreshFailed: true }),
	})
	list.reset()
	list.replaceWindow(nextWindow)
	expect(summarize(snapshot)).toEqual({
		names: ['created', 'existing'],
		totalCount: 21,
		hasMore: true,
	})
})

test('selection refetch keeps a created user that page one omitted', () => {
	const oldest = user(1, 'oldest')
	const afterCreate = nextAdminUsersWindowAfterCreate({
		currentItems: [oldest, older],
		currentHasMore: true,
		currentTotal: 2,
		payload: payload([oldest, older], 3, { pageSize: 2 }),
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
