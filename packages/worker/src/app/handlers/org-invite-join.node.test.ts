import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
} from '#worker/orgs/invite-links.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	syncSeatsAfterMembershipChange: vi.fn(),
	renderAppPage: vi.fn(
		async (input: { loaderData?: unknown; status?: number }) =>
			new Response(JSON.stringify(input.loaderData ?? null), {
				status: input.status ?? 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))
vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) =>
		mocks.renderAppPage(args[0] as { loaderData?: unknown; status?: number }),
}))

const { createOrgInviteJoinHandler, createOrgInviteJoinPostHandler } =
	await import('./org-invite-join.ts')

const owner = { id: 1, personId: 'a'.repeat(64) }
const joiner = { id: 2, personId: 'b'.repeat(64) }

let sqlite: DatabaseSync
let db: D1Database
let auditDb: D1Database
let orgId = ''
let token = ''

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	auditDb = createAuditTestDb()
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'avatar_key'],
	})
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person, email] of [
		['ada', owner, 'ada@example.com'],
		['bob', joiner, 'bob@example.com'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (
					id, username, email, password_hash, stable_user_id,
					display_name, email_verified_at
				 ) VALUES (?, ?, ?, 'x', ?, ?, ?)`,
			)
			.run(person.id, username, email, person.personId, username, now)
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
			personId: owner.personId,
			audit: createTestOrgAuditWriter({ db: auditDb }),
			slug: 'join-co',
			displayName: 'Join Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'join-co'`)
		.first<{ id: string }>())!.id
	token = generateInviteLinkToken()
	await createOrgInviteLink({
		db,
		orgId,
		target: { kind: 'membership', role: 'member' },
		createdByUserId: owner.personId,
		tokenHash: await hashInviteLinkToken(token),
		audit: createTestOrgAuditWriter({ db: auditDb }),
	})
}

function createEnv() {
	return { APP_DB: db, AUDIT_DB: auditDb } as Env
}

function signInJoiner(emailVerified = true) {
	const personId = personIdFromStored(joiner.personId)
	const user = {
		userId: joiner.id,
		username: 'bob',
		email: 'bob@example.com',
		emailVerified,
		mcpUser: {
			userId: personId,
			username: 'bob',
			email: 'bob@example.com',
			displayName: 'bob',
		},
		request: deriveRequestContext({
			user: { userId: personId, username: 'bob' },
			source: { kind: 'session' },
			orgBinding: {
				org: { id: ownerIdFromStored(joiner.personId), slug: 'bob' },
				role: 'owner',
			},
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.syncSeatsAfterMembershipChange.mockClear()
	mocks.renderAppPage.mockClear()
	await seed()
})

test('join page shows org confirmation without members for a valid link', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await createOrgInviteJoinHandler(createEnv()).handler({
		request: new Request(`https://kody.test/join/${token}`),
		params: { token },
	} as never)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		orgInviteJoin: {
			ok: true
			org: { slug: string; displayName: string | null }
			authenticated: boolean
			alreadyMember: boolean
		}
	}
	expect(body.orgInviteJoin).toMatchObject({
		ok: true,
		org: { slug: 'join-co', displayName: 'Join Co' },
		authenticated: false,
		alreadyMember: false,
	})
	expect(JSON.stringify(body)).not.toContain(owner.personId)
	expect(JSON.stringify(body)).not.toContain('ada@example.com')
})

test('join post adds the member and returns the org redirect', async () => {
	signInJoiner(true)
	const response = await createOrgInviteJoinPostHandler(createEnv()).handler({
		request: new Request(`https://kody.test/join/${token}`, {
			method: 'POST',
		}),
		params: { token },
	} as never)
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		alreadyMember: false,
		orgSlug: 'join-co',
		redirectTo: '/@join-co',
	})
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalled()
})

test('expired links show a clear error on the join page', async () => {
	sqlite
		.prepare(
			`UPDATE org_invite_links SET expires_at = '2020-01-01T00:00:00.000Z'`,
		)
		.run()
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await createOrgInviteJoinHandler(createEnv()).handler({
		request: new Request(`https://kody.test/join/${token}`),
		params: { token },
	} as never)
	expect(response.status).toBe(400)
	expect(await response.json()).toMatchObject({
		orgInviteJoin: {
			ok: false,
			reason: 'expired',
			error: 'This invite link has expired.',
		},
	})
})
