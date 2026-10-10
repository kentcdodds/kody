import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	syncSeatsAfterMembershipChange: vi.fn(),
	assertCanAcceptFreeOrgOwnership: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))
vi.mock('#worker/orgs/billing.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/billing.ts')>()
	return {
		...actual,
		assertCanAcceptFreeOrgOwnership: (...args: Array<unknown>) =>
			mocks.assertCanAcceptFreeOrgOwnership(...args),
	}
})

const {
	createOrgMembersApiHandler,
	createOrgMembersInvitePostHandler,
	createOrgMembersRemovePostHandler,
	createOrgMembersRolePostHandler,
} = await import('./org-members.ts')

const people = {
	ada: { id: 9, personId: 'a'.repeat(64) },
	bob: { id: 10, personId: 'b'.repeat(64) },
	cara: { id: 11, personId: 'c'.repeat(64) },
	dan: { id: 12, personId: 'd'.repeat(64) },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database
let acmeId = ''

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name)
				 VALUES (?, ?, ?, 'x', ?, ?)`,
			)
			.run(
				person.id,
				username,
				`${username}@example.com`,
				person.personId,
				username,
			)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.ada.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	acmeId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>())!.id
	for (const [person, role] of [
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(acmeId, people[person].personId, role, now)
	}
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, ?, ?, ?)`,
		)
		.run(acmeId, people.dan.personId, people.ada.personId, now, now)
}

function createEnv() {
	return { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
}

async function signIn(person: Person, request: Request) {
	const slug = new URL(request.url).pathname.split('/')[1]?.slice(1) ?? person
	const binding = (await loadOrgBindingForSlug(
		db,
		people[person].personId,
		slug,
	)) ?? {
		org: {
			id: ownerIdFromStored(people[person].personId),
			slug: person,
		},
		role: 'owner' as const,
	}
	const user = {
		userId: people[person].id,
		username: person,
		email: `${person}@example.com`,
		mcpUser: {
			userId: personIdFromStored(people[person].personId),
			username: person,
			email: `${person}@example.com`,
			displayName: person,
		},
		request: deriveRequestContext({
			user: {
				userId: personIdFromStored(people[person].personId),
				username: person,
			},
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
	mocks.requireAuthenticatedPageUser.mockResolvedValue(user)
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.requireAuthenticatedPageUser.mockReset()
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('members JSON is 404 for collaborators and readable by billing', async () => {
	const env = createEnv()
	const collab = new Request('https://kody.test/@zeta-co/-/members.json')
	await signIn('dan', collab)
	expect(
		(
			await createOrgMembersApiHandler(env).handler({
				request: collab,
			} as never)
		).status,
	).toBe(404)

	const billing = new Request('https://kody.test/@zeta-co/-/members.json')
	await signIn('cara', billing)
	const readable = await createOrgMembersApiHandler(env).handler({
		request: billing,
	} as never)
	expect(readable.status).toBe(200)
	const payload = (await readable.json()) as {
		canManage: boolean
		members: Array<{ username: string; role: string }>
	}
	expect(payload.canManage).toBe(false)
	expect(
		payload.members.map((member) => [member.username, member.role]),
	).toEqual([
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	])
})

test('member cannot change roles, invite, or remove; owner can; last owner is protected', async () => {
	const env = createEnv()
	const roleReq = new Request(
		'https://kody.test/@zeta-co/-/members/role.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: people.bob.personId, role: 'billing' }),
		},
	)
	await signIn('bob', roleReq)
	expect(
		(
			await createOrgMembersRolePostHandler(env).handler({
				request: roleReq,
			} as never)
		).status,
	).toBe(403)

	const billingInvite = new Request(
		'https://kody.test/@zeta-co/-/members/invite.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
		},
	)
	await signIn('cara', billingInvite)
	expect(
		(
			await createOrgMembersInvitePostHandler(env).handler({
				request: billingInvite,
			} as never)
		).status,
	).toBe(403)

	const invalidRoleInvite = new Request(
		'https://kody.test/@zeta-co/-/members/invite.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ invitee: 'eve@example.com', role: 'admin' }),
		},
	)
	await signIn('ada', invalidRoleInvite)
	const rejectedRole = await createOrgMembersInvitePostHandler(env).handler({
		request: invalidRoleInvite,
	} as never)
	expect(rejectedRole.status).toBe(400)
	expect(await rejectedRole.json()).toMatchObject({
		ok: false,
		error: 'Choose a valid role.',
	})

	const ownerInvite = new Request(
		'https://kody.test/@zeta-co/-/members/invite.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
		},
	)
	await signIn('ada', ownerInvite)
	const invited = await createOrgMembersInvitePostHandler(env).handler({
		request: ownerInvite,
	} as never)
	expect(invited.status).toBe(200)
	expect(await invited.json()).toMatchObject({
		ok: true,
		invite: { prompt: expect.stringContaining('inviteAccept') },
	})

	const ownerRole = new Request(
		'https://kody.test/@zeta-co/-/members/role.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: people.bob.personId, role: 'billing' }),
		},
	)
	await signIn('ada', ownerRole)
	expect(
		(
			await createOrgMembersRolePostHandler(env).handler({
				request: ownerRole,
			} as never)
		).status,
	).toBe(200)

	const lastOwner = new Request(
		'https://kody.test/@zeta-co/-/members/remove.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: people.ada.personId }),
		},
	)
	await signIn('ada', lastOwner)
	const blocked = await createOrgMembersRemovePostHandler(env).handler({
		request: lastOwner,
	} as never)
	expect(blocked.status).toBe(400)
	expect(await blocked.json()).toMatchObject({
		error: 'The last Owner cannot be removed.',
	})
})

test('signup org membership writes stay off the web even for a second owner', async () => {
	const env = createEnv()
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(people.ada.personId, people.bob.personId, '2026-01-02T00:00:00.000Z')

	const list = new Request('https://kody.test/@ada/-/members.json')
	await signIn('bob', list)
	expect(
		await (
			await createOrgMembersApiHandler(env).handler({ request: list } as never)
		).json(),
	).toMatchObject({
		ok: true,
		org: { personal: true },
		canManage: false,
	})

	const invite = new Request('https://kody.test/@ada/-/members/invite.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
	})
	await signIn('bob', invite)
	const invited = await createOrgMembersInvitePostHandler(env).handler({
		request: invite,
	} as never)
	expect(invited.status).toBe(400)
	expect(await invited.json()).toMatchObject({
		error: expect.stringMatching(/personal organization/),
	})
})
