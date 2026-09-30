import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { adminUserListItemFieldNames } from './admin-users.ts'
import { type AdminUsersMutationData } from '#universal/loader-data.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import type * as UsersData from '#worker/admin/users-data.ts'
import * as AdminUserCreation from '#worker/identity/admin-user-creation.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	adminCreateUserWithPasswordSetup: vi.fn(),
	scheduleUserCreatedEvent: vi.fn(),
	loadAdminUsersData: undefined as
		| ((...args: Array<unknown>) => Promise<unknown>)
		| undefined,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/identity/admin-user-creation.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AdminUserCreation>()
	return {
		...actual,
		adminCreateUserWithPasswordSetup: (...args: Array<unknown>) =>
			mockModule.adminCreateUserWithPasswordSetup(...args),
	}
})

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		mockModule.scheduleUserCreatedEvent(...args),
}))

vi.mock('#worker/admin/users-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof UsersData>()
	return {
		...actual,
		loadAdminUsersData: (
			...args: Parameters<typeof actual.loadAdminUsersData>
		) =>
			mockModule.loadAdminUsersData
				? mockModule.loadAdminUsersData(...args)
				: actual.loadAdminUsersData(...args),
	}
})

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs a deterministic request IP for its audit assertions.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

type UserRow = {
	id: number
	username: string
	email: string
	email_verified_at?: string | null
	plan?: string
	stripe_plan?: string | null
	stripe_customer_id?: string | null
	suspended_at?: string | null
	email_outbound_paused_at?: string | null
	email_verification_delivery_status?: string | null
	email_verification_delivery_at?: string | null
	email_verification_delivery_detail?: string | null
	email_verification_delivery_class?: string | null
	created_at: string
	updated_at: string
}

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: stableUserId(1),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createAdminTestEnv(input: {
	users: Array<UserRow>
	userRoles: Array<[number, RoleName]>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	for (const user of input.users) {
		const row = {
			password_hash: 'test-password-hash',
			stable_user_id: stableUserId(user.id),
			...user,
		}
		const columns = Object.keys(row)
		sqlite
			.prepare(
				`INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			)
			.run(...Object.values(row))
	}
	for (const [userId, role] of input.userRoles) {
		sqlite
			.prepare(
				`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?`,
			)
			.run(userId, role)
	}
	return { COOKIE_SECRET: 'secret', APP_DB: createD1FromSqlite(sqlite) }
}
const { createAdminUsersApiHandler } = await import('./admin-users.ts')

function makeUser(
	id: number,
	username: string,
	overrides: Partial<UserRow> = {},
): UserRow {
	return {
		id,
		username,
		email: `${username}@example.com`,
		created_at: '2026-01-01 00:00:00',
		updated_at: '2026-01-02 00:00:00',
		...overrides,
	}
}

function setupAdminUsers(
	users: Array<UserRow>,
	userRoles: Array<[number, RoleName]>,
	actorRoles: Array<RoleName> = ['admin'],
) {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(actorRoles),
	)
	const env = createAdminTestEnv({ users, userRoles })
	const { handler } = createAdminUsersApiHandler(env as unknown as Env)
	const send = (search: string, body?: Record<string, unknown>) => {
		const href = `https://example.com/admin/users.json${search}`
		return handler({
			request: new Request(
				href,
				body
					? {
							method: 'POST',
							headers: {
								Accept: 'application/json',
								'Content-Type': 'application/json',
							},
							body: JSON.stringify(body),
						}
					: { headers: { Accept: 'application/json' } },
			),
			params: {},
			url: new URL(href),
		} as never)
	}
	return {
		env,
		get: (search = '') => send(search),
		post: (body: Record<string, unknown>, search = '') => send(search, body),
		list: async (search: string) => {
			const response = await send(search)
			expect(response.status).toBe(200)
			return (await response.json()) as AdminUsersMutationData
		},
	}
}

const stableIds = (payload: { users: Array<{ stableUserId: string }> }) =>
	payload.users.map((user) => user.stableUserId)

function expectAdminAudit(action: string, reason?: string) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action,
			result: 'success',
			...(reason === undefined ? {} : { reason }),
		}),
	)
}

test('admin users list payload exposes only account metadata fields', async () => {
	const { get } = setupAdminUsers(
		[
			makeUser(1, 'admin-user', {
				email: 'admin@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				plan: 'pro',
			}),
			makeUser(2, 'member', {
				email_verified_at: null,
				plan: 'free',
				stripe_plan: 'standard',
				stripe_customer_id: 'cus_member',
			}),
		],
		[
			[1, 'admin'],
			[2, 'user'],
		],
	)

	const response = await get()

	expect(response.status).toBe(200)
	const payload = (await response.json()) as AdminUsersMutationData
	expect(Object.keys(payload).sort()).toEqual(
		[
			'availablePlans',
			'availableRoles',
			'ok',
			'page',
			'pageSize',
			'selectedUser',
			'total',
			'users',
		].sort(),
	)
	expect(payload.selectedUser).toBeNull()
	for (const user of payload.users) {
		expect(Object.keys(user).sort()).toEqual(
			[...adminUserListItemFieldNames].sort(),
		)
	}
	expect(payload.users).toEqual([
		expect.objectContaining({
			email: 'admin@example.com',
			email_verified: true,
			email_verified_at: '2026-01-01T00:00:00.000Z',
			plan: 'pro',
			manualPlan: 'pro',
			stripePlan: null,
			effectivePlan: 'pro',
			stripeCustomerLinked: false,
		}),
		expect.objectContaining({
			email: 'member@example.com',
			email_verified: false,
			email_verified_at: null,
			plan: 'free',
			manualPlan: 'free',
			stripePlan: 'standard',
			effectivePlan: 'standard',
			stripeCustomerLinked: true,
		}),
	])
})

test('admin users list applies selected, q, role, and pagination filters', async () => {
	const { list } = setupAdminUsers(
		[
			makeUser(1, 'admin-user', { email: 'admin@example.com' }),
			makeUser(2, 'searchable-member', { email: 'member@example.com' }),
			makeUser(3, 'another-member', { email: 'searchable@example.com' }),
		],
		[
			[1, 'admin'],
			[2, 'user'],
			[3, 'user'],
		],
	)

	// Selected user on a later page is still returned for the detail pane.
	const paged = await list(`?pageSize=1&page=1&selected=${stableUserId(3)}`)
	expect(stableIds(paged)).toEqual([stableUserId(1)])
	expect(paged.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(3),
			username: 'another-member',
			email: 'searchable@example.com',
		}),
	)

	// Selected user excluded by the active role filter is still returned.
	const filtered = await list(`?role=admin&selected=${stableUserId(2)}`)
	expect(stableIds(filtered)).toEqual([stableUserId(1)])
	expect(filtered.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			username: 'searchable-member',
		}),
	)

	expect((await list(`?selected=${stableUserId(99)}`)).selectedUser).toBeNull()
	expect((await list('?selected=123')).selectedUser).toBeNull()

	// q matches username or email; total reflects the filtered set. Unknown
	// role values are ignored rather than filtering everything out, and
	// filters compose with pagination.
	const cases: Array<[string, number, Array<number>]> = [
		['?q=searchable', 2, [2, 3]],
		['?role=admin', 1, [1]],
		['?q=searchable&role=admin', 0, []],
		['?role=not-a-role', 3, [1, 2, 3]],
		['?q=searchable&pageSize=1&page=2', 2, [3]],
	]
	for (const [search, total, ids] of cases) {
		const payload = await list(search)
		expect([search, payload.total, stableIds(payload)]).toEqual([
			search,
			total,
			ids.map(stableUserId),
		])
	}
})

test('admin users list applies verification=stalled to the slice and total', async () => {
	const staleAt = '2020-01-01T00:00:00.000Z'
	const { list } = setupAdminUsers(
		[
			makeUser(1, 'stalled-raul', {
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: staleAt,
			}),
			makeUser(2, 'fresh-accepted', {
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: new Date().toISOString(),
			}),
			makeUser(3, 'bounced', {
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_at: staleAt,
			}),
			makeUser(4, 'already-verified', {
				email_verified_at: '2026-01-01T00:00:00.000Z',
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: staleAt,
			}),
		],
		[
			[1, 'user'],
			[2, 'user'],
			[3, 'user'],
			[4, 'user'],
		],
	)

	const payload = await list('?verification=stalled')
	expect(payload.total).toBe(1)
	expect(
		payload.users.map((user: { username: string }) => user.username),
	).toEqual(['stalled-raul'])

	expect((await list('?verification=not-a-filter')).total).toBe(4)
})

test('assign role action updates user roles and logs audit event', async () => {
	const { post } = setupAdminUsers([makeUser(2, 'member')], [[2, 'user']])

	const response = await post({
		action: 'assign_role',
		stableUserId: stableUserId(2),
		role: 'admin',
	})

	expect(response.status).toBe(200)
	const payload = (await response.json()) as AdminUsersMutationData
	expect(payload.users[0]?.roles).toContain('admin')
	// Mutations return the updated target so the client can patch it into
	// an infinite-scroll window without resetting to the first page.
	expect(payload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			roles: expect.arrayContaining(['admin', 'user']),
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'admin', action: 'assign_role' }),
	)
})

test('remove role rejects the last admin and removes admin when another admin remains', async () => {
	const removeAdmin = (id: number) => ({
		action: 'remove_role',
		stableUserId: stableUserId(id),
		role: 'admin',
	})
	const solo = setupAdminUsers([makeUser(1, 'solo-admin')], [[1, 'admin']])
	expect((await solo.post(removeAdmin(1))).status).toBe(409)

	const { post } = setupAdminUsers(
		[makeUser(1, 'first-admin'), makeUser(2, 'second-admin')],
		[
			[1, 'admin'],
			[2, 'admin'],
			[2, 'user'],
		],
	)
	const response = await post(removeAdmin(2))

	expect(response.status).toBe(200)
	const payload = (await response.json()) as AdminUsersMutationData
	const secondAdmin = payload.users.find(
		(user) => user.stableUserId === stableUserId(2),
	)
	if (!secondAdmin) throw new Error('Expected second admin in payload')
	expect(secondAdmin.roles).not.toContain('admin')
	expectAdminAudit('remove_role')
})

test('update plan action sets, maps null to free, validates, and scopes plan changes', async () => {
	const { post } = setupAdminUsers(
		[makeUser(2, 'member', { plan: 'max' })],
		[[2, 'user']],
	)
	const target = stableUserId(2)

	const setPlanResponse = await post({
		action: 'update_plan',
		stableUserId: target,
		plan: 'pro',
	})
	expect(setPlanResponse.status).toBe(200)
	expect(
		((await setPlanResponse.json()) as AdminUsersMutationData).users[0]?.plan,
	).toBe('pro')
	expectAdminAudit('update_plan', `target_stable_user_id=${target};plan=pro`)

	const clearPlanResponse = await post({
		action: 'update_plan',
		stableUserId: target,
		plan: null,
	})
	expect(clearPlanResponse.status).toBe(200)
	expect(
		((await clearPlanResponse.json()) as AdminUsersMutationData).users[0]?.plan,
	).toBe('free')
	expectAdminAudit('update_plan', `target_stable_user_id=${target};plan=free`)

	for (const body of [
		{ action: 'update_plan', stableUserId: target, plan: 'enterprise' },
		{ action: 'update_plan', stableUserId: target },
		{ action: 'update_plan', stableUserId: 2, plan: 'pro' },
	]) {
		expect((await post(body)).status).toBe(400)
	}

	const missingUserResponse = await post({
		action: 'update_plan',
		stableUserId: stableUserId(42),
		plan: 'pro',
	})
	expect(missingUserResponse.status).toBe(404)
})

test('suspend, unsuspend, and resume email actions update flags and log audit events', async () => {
	const { post } = setupAdminUsers(
		[
			makeUser(2, 'member', {
				email_outbound_paused_at: '2026-07-20T00:00:00.000Z',
			}),
		],
		[[2, 'user']],
	)
	const targetReason = `target_stable_user_id=${stableUserId(2)}`
	const act = (action: string, id = 2) =>
		post({ action, stableUserId: stableUserId(id) })

	const suspendResponse = await act('suspend_user')
	expect(suspendResponse.status).toBe(200)
	expect(
		((await suspendResponse.json()) as AdminUsersMutationData).users[0]
			?.suspended_at,
	).toBeTruthy()
	expectAdminAudit('suspend_user', targetReason)

	const unsuspendResponse = await act('unsuspend_user')
	expect(unsuspendResponse.status).toBe(200)
	expect(
		((await unsuspendResponse.json()) as AdminUsersMutationData).users[0]
			?.suspended_at,
	).toBeNull()
	expectAdminAudit('unsuspend_user', targetReason)

	const resumeResponse = await act('resume_email_outbound')
	expect(resumeResponse.status).toBe(200)
	expect(
		((await resumeResponse.json()) as AdminUsersMutationData).users[0]
			?.email_outbound_paused_at,
	).toBeNull()
	expectAdminAudit('resume_email_outbound', targetReason)

	expect((await act('suspend_user', 42)).status).toBe(404)

	// Admins cannot suspend their own account (actor id is 1).
	const self = setupAdminUsers(
		[makeUser(1, 'admin-user', { email: 'admin@example.com' })],
		[[1, 'admin']],
	)
	const selfResponse = await self.post({
		action: 'suspend_user',
		stableUserId: stableUserId(1),
	})
	expect(selfResponse.status).toBe(400)
})

test('admin users API returns 403 without read:user:any permission', async () => {
	const { get } = setupAdminUsers([], [], ['user'])
	expect((await get()).status).toBe(403)
})

test('mark email verified and mint verify url actions update the account and log audit events', async () => {
	const { post } = setupAdminUsers(
		[
			makeUser(2, 'member', {
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_class: 'sender_block',
				email_verification_delivery_detail:
					'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
			}),
		],
		[[2, 'user']],
	)
	const targetReason = `target_stable_user_id=${stableUserId(2)}`
	const act = (action: string) =>
		post({ action, stableUserId: stableUserId(2) })

	const mintResponse = await act('mint_verify_url')
	expect(mintResponse.status).toBe(200)
	const minted = (await mintResponse.json()) as AdminUsersMutationData
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/example.com\/verify-email\?token=/,
	)
	expect(minted.users[0]?.email_verified).toBe(false)
	expectAdminAudit('mint_verify_url', targetReason)

	const verifyResponse = await act('mark_email_verified')
	expect(verifyResponse.status).toBe(200)
	const verified = (await verifyResponse.json()) as AdminUsersMutationData
	expect(verified.users[0]?.email_verified).toBe(true)
	expect(verified.users[0]?.email_verification_delivery).toBeNull()
	expectAdminAudit('mark_email_verified', targetReason)

	expect((await act('mint_verify_url')).status).toBe(400)
})

test('create_user action returns setup link, logs audit, maps duplicate email to 409, and keeps the setup link when list refresh fails', async () => {
	const createdUser = {
		userId: 9,
		stableUserId: stableUserId(9),
		email: 'new-user@example.com',
		username: 'new-user',
		setupLink: 'https://example.com/reset-password?token=setup',
		setupTokenExpiresAt: 1_800_000_000_000,
	}
	const { env, post } = setupAdminUsers(
		[
			makeUser(9, 'new-user', {
				email_verified_at: '2026-09-10T00:00:00.000Z',
				plan: 'free',
			}),
		],
		[[9, 'user']],
	)
	const createBody = {
		action: 'create_user',
		email: 'new-user@example.com',
		username: 'new-user',
	}
	const createdUserPayload = {
		stableUserId: createdUser.stableUserId,
		email: createdUser.email,
		username: createdUser.username,
		setupLink: createdUser.setupLink,
		setupTokenExpiresAt: createdUser.setupTokenExpiresAt,
	}

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const created = await post(createBody)
	expect(created.status).toBe(200)
	const createdPayload = (await created.json()) as AdminUsersMutationData
	expect(createdPayload.createdUser).toEqual(createdUserPayload)
	expect(createdPayload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: createdUser.stableUserId,
			username: createdUser.username,
			email: createdUser.email,
		}),
	)
	expect(createdPayload.users).toEqual([
		expect.objectContaining({ stableUserId: createdUser.stableUserId }),
	])
	expect(createdPayload.createdUserInFilteredList).toBe(true)

	const filterCases: Array<[string, boolean]> = [
		['?role=admin', false],
		['?q=nobody-matches', false],
		['?q=new-user', true],
		['?verification=stalled', false],
	]
	for (const [search, inList] of filterCases) {
		mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(
			createdUser,
		)
		const response = await post(createBody, search)
		expect(response.status).toBe(200)
		const payload = (await response.json()) as AdminUsersMutationData
		expect([search, payload.createdUserInFilteredList]).toEqual([
			search,
			inList,
		])
	}
	expect(mockModule.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env,
		user: {
			id: createdUser.stableUserId,
			username: createdUser.username,
			email: createdUser.email,
		},
		source: 'admin',
	})
	expectAdminAudit('create_user')

	mockModule.adminCreateUserWithPasswordSetup.mockRejectedValueOnce(
		new AdminUserCreation.AdminCreateUserError(
			'email_exists',
			'That email is already in use.',
		),
	)
	const duplicate = await post({
		action: 'create_user',
		email: 'new-user@example.com',
	})
	expect(duplicate.status).toBe(409)
	expect(await duplicate.json()).toEqual({
		ok: false,
		error: 'That email is already in use.',
		code: 'email_exists',
	})

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	mockModule.loadAdminUsersData = async () => {
		throw new Error('list refresh failed')
	}
	consoleWarn.mockImplementation(() => {})
	try {
		const refreshFailed = await post({
			action: 'create_user',
			email: 'refresh-fail@example.com',
			username: 'refresh-fail',
		})
		expect(refreshFailed.status).toBe(200)
		const refreshFailedPayload =
			(await refreshFailed.json()) as AdminUsersMutationData
		expect(refreshFailedPayload.ok).toBe(true)
		expect(refreshFailedPayload.listRefreshFailed).toBe(true)
		expect(refreshFailedPayload.createdUser).toEqual(createdUserPayload)
		expect(refreshFailedPayload.updatedUser).toEqual(
			expect.objectContaining({
				stableUserId: createdUser.stableUserId,
				username: createdUser.username,
			}),
		)
		expect(refreshFailedPayload.createdUserInFilteredList).toBe(true)
		expect(consoleWarn).toHaveBeenCalledWith(
			'admin-users-create-list-refresh-failed',
			expect.any(Error),
		)
	} finally {
		mockModule.loadAdminUsersData = undefined
	}
})
