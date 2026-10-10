import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	renderAppPage: vi.fn(async (input: { status?: number; notFound?: boolean }) =>
		Response.json(
			{
				notFound: input.notFound ?? false,
				unauthorized: false,
			},
			{ status: input.status ?? 200 },
		),
	),
	softDeleteOrg: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: never) => mocks.renderAppPage(input),
}))
vi.mock('#worker/orgs/soft-delete.ts', () => ({
	softDeleteOrg: (...args: Array<unknown>) => mocks.softDeleteOrg(...args),
}))

const {
	createOrgSettingsApiHandler,
	createOrgSettingsDeletePostHandler,
	createOrgSettingsPostHandler,
} = await import('./org-settings.ts')

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
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
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
	return {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef',
	} as Env
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
	return user
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.requireAuthenticatedPageUser.mockReset()
	mocks.renderAppPage.mockClear()
	mocks.softDeleteOrg.mockClear()
	await seed()
})

test('settings JSON is 404 for an unknown slug, collaborator, and 403 for a member write', async () => {
	const env = createEnv()
	const unknown = new Request('https://kody.test/@missing/-/settings.json')
	await signIn('ada', unknown)
	expect(
		(
			await createOrgSettingsApiHandler(env).handler({
				request: unknown,
			} as never)
		).status,
	).toBe(404)

	const collab = new Request('https://kody.test/@zeta-co/-/settings.json')
	await signIn('dan', collab)
	expect(
		(
			await createOrgSettingsApiHandler(env).handler({
				request: collab,
			} as never)
		).status,
	).toBe(404)

	const memberGet = new Request('https://kody.test/@zeta-co/-/settings.json')
	await signIn('bob', memberGet)
	const readable = await createOrgSettingsApiHandler(env).handler({
		request: memberGet,
	} as never)
	expect(readable.status).toBe(200)
	expect(await readable.json()).toMatchObject({
		ok: true,
		canManage: false,
		org: { slug: 'zeta-co', personal: false },
	})

	const memberWrite = new Request(
		'https://kody.test/@zeta-co/-/settings.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayName: 'Nope' }),
		},
	)
	await signIn('bob', memberWrite)
	expect(
		(
			await createOrgSettingsPostHandler(env).handler({
				request: memberWrite,
			} as never)
		).status,
	).toBe(403)
})

test('owner can update team settings and cannot delete a personal org', async () => {
	const env = createEnv()
	const update = new Request('https://kody.test/@zeta-co/-/settings.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: 'Acme Co' }),
	})
	await signIn('ada', update)
	const updated = await createOrgSettingsPostHandler(env).handler({
		request: update,
	} as never)
	expect(updated.status).toBe(200)
	expect(await updated.json()).toMatchObject({
		ok: true,
		org: { displayName: 'Acme Co', slug: 'zeta-co' },
	})

	const personal = new Request(
		'https://kody.test/@ada/-/settings/delete.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ confirmation: 'ada' }),
		},
	)
	await signIn('ada', personal)
	const blocked = await createOrgSettingsDeletePostHandler(env).handler({
		request: personal,
	} as never)
	expect(blocked.status).toBe(400)
	expect(await blocked.json()).toMatchObject({
		ok: false,
		error: expect.stringMatching(/Data & deletion/),
	})
	expect(mocks.softDeleteOrg).not.toHaveBeenCalled()

	const del = new Request('https://kody.test/@zeta-co/-/settings/delete.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ confirmation: 'zeta-co' }),
	})
	await signIn('ada', del)
	expect(
		(
			await createOrgSettingsDeletePostHandler(env).handler({
				request: del,
			} as never)
		).status,
	).toBe(200)
	expect(mocks.softDeleteOrg).toHaveBeenCalled()
})

test('a second owner still treats a signup org as personal', async () => {
	const env = createEnv()
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(people.ada.personId, people.bob.personId, '2026-01-02T00:00:00.000Z')

	const get = new Request('https://kody.test/@ada/-/settings.json')
	await signIn('bob', get)
	const body = await (
		await createOrgSettingsApiHandler(env).handler({ request: get } as never)
	).json()
	expect(body).toMatchObject({
		ok: true,
		org: { slug: 'ada', personal: true },
		canManage: false,
	})

	const del = new Request('https://kody.test/@ada/-/settings/delete.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ confirmation: 'ada' }),
	})
	await signIn('bob', del)
	const blocked = await createOrgSettingsDeletePostHandler(env).handler({
		request: del,
	} as never)
	expect(blocked.status).toBe(400)
	expect(mocks.softDeleteOrg).not.toHaveBeenCalled()
})
