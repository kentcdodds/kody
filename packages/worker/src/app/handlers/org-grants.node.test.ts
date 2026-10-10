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
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))

const { createOrgCollaboratorsApiHandler } =
	await import('./org-collaborators.ts')
const { createOrgGrantsApiHandler, createOrgGrantsRevokePostHandler } =
	await import('./org-grants.ts')

const people = {
	ada: { id: 9, personId: 'a'.repeat(64) },
	bob: { id: 10, personId: 'b'.repeat(64) },
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
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(acmeId, people.bob.personId, now)
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			kody_id TEXT,
			user_id TEXT,
			deleted_at TEXT
		)`,
	)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, name, kody_id, user_id)
			 VALUES ('pkg-1', 'Demo Package', 'demo-package', ?)`,
		)
		.run(people.ada.personId)
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?)`,
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
	await seed()
})

test('grants list includes outside collaborator grants; collaborators page lists them', async () => {
	const env = createEnv()
	const grantsReq = new Request('https://kody.test/@zeta-co/-/grants.json')
	await signIn('ada', grantsReq)
	const grantsRes = await createOrgGrantsApiHandler(env).handler({
		request: grantsReq,
	} as never)
	expect(grantsRes.status).toBe(200)
	const grantsPayload = (await grantsRes.json()) as {
		canManage: boolean
		grants: Array<{ id: string; subjectLabel: string; presetLabel: string }>
	}
	expect(grantsPayload.canManage).toBe(true)
	expect(grantsPayload.grants).toHaveLength(1)
	expect(grantsPayload.grants[0]?.subjectLabel).toBe('@dan')
	expect(grantsPayload.grants[0]?.presetLabel).toBe('Use')

	const collabReq = new Request(
		'https://kody.test/@zeta-co/-/collaborators.json',
	)
	await signIn('ada', collabReq)
	const collabRes = await createOrgCollaboratorsApiHandler(env).handler({
		request: collabReq,
	} as never)
	expect(collabRes.status).toBe(200)
	const collabPayload = (await collabRes.json()) as {
		collaborators: Array<{ username: string; grants: Array<{ id: string }> }>
	}
	expect(collabPayload.collaborators).toHaveLength(1)
	expect(collabPayload.collaborators[0]).toMatchObject({
		userId: people.dan.personId,
		username: 'dan',
		displayName: 'dan',
		grants: [
			expect.objectContaining({
				id: 'grant-1',
				presetLabel: 'Use',
				resourceLabel: 'Demo Package',
			}),
		],
	})
})

test('owner can revoke a grant', async () => {
	const env = createEnv()
	const revokeReq = new Request(
		'https://kody.test/@zeta-co/-/grants/revoke.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ grantId: 'grant-1' }),
		},
	)
	await signIn('ada', revokeReq)
	const revoked = await createOrgGrantsRevokePostHandler(env).handler({
		request: revokeReq,
	} as never)
	expect(revoked.status).toBe(200)
	const payload = (await revoked.json()) as { grants: Array<unknown> }
	expect(payload.grants).toEqual([])
})

test('collaborators JSON is 404 for grant-only people', async () => {
	const env = createEnv()
	const req = new Request('https://kody.test/@zeta-co/-/collaborators.json')
	await signIn('dan', req)
	expect(
		(
			await createOrgCollaboratorsApiHandler(env).handler({
				request: req,
			} as never)
		).status,
	).toBe(404)
})
