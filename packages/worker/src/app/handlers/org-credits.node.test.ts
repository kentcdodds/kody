import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type * as OrgCreditsData from '#app/org-credits-data.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	loadOrgCreditsData: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		input,
	})),
	renderAppPage: vi.fn(
		async (input: {
			loaderData?: unknown
			status?: number
			notFound?: boolean
		}) =>
			Response.json(
				{
					loaderData: input.loaderData ?? null,
					notFound: input.notFound ?? false,
				},
				{ status: input.status ?? 200 },
			),
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/org-credits-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OrgCreditsData>()
	return {
		...actual,
		loadOrgCreditsData: (input: Record<string, unknown>) =>
			mocks.loadOrgCreditsData(input),
	}
})
vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: never) => mocks.renderAppPage(input),
}))

const { createOrgCreditsApiHandler, createOrgCreditsHandler } =
	await import('./org-credits.ts')
const { encodeCreditLedgerCursor } = await import('#app/org-credits-data.ts')

const now = '2026-01-01T00:00:00.000Z'

/** Personal org per person, plus `acme` where Ada owns, Bob is a member, and Cara is billing. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
	cara: { id: 11, personId: 'person-cara' },
	dan: { id: 12, personId: 'person-dan' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, ?)`,
			)
			.run(person.personId, username, now, now)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(person.personId, person.personId, now)
	}
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?)`,
		)
		.run(now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(people[person].personId, role, now)
	}
}

function createEnv() {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		APP_DB: db,
	} as unknown as Env
}

function signInAs(person: Person | null) {
	const sign = async (request: Request, env: Env) => {
		if (!person) return null
		const { id, personId } = people[person]
		const mcpUser = {
			userId: personIdFromStored(personId),
			email: `${person}@example.com`,
			displayName: person,
		}
		const resolution = await loadRequestOrgResolution(request, env, personId)
		const orgBinding =
			typeof resolution === 'string'
				? {
						org: { id: personId as never, slug: person },
						role: 'owner' as const,
					}
				: resolution
		return {
			sessionUserId: String(id),
			userId: id,
			username: person,
			email: mcpUser.email,
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: person,
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [String(id)],
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding,
			}),
		} satisfies AuthenticatedAppUser
	}
	mocks.readAuthenticatedAppUser.mockImplementation(sign)
	mocks.requireAuthenticatedPageUser.mockImplementation(
		async (request: Request, env: Env) =>
			(await sign(request, env)) ??
			Response.redirect('https://example.com/login', 302),
	)
}

function call(
	createHandler: (env: Env) => { handler: (input: never) => unknown },
	path: string,
) {
	const url = new URL(`https://example.com${path}`)
	return createHandler(createEnv()).handler({
		request: new Request(url),
		params: {},
		url,
	} as never) as Promise<Response>
}

beforeEach(async () => {
	vi.clearAllMocks()
	await seed()
	signInAs('ada')
})

test('every member can open credits; only owners and billing admins read billing', async () => {
	const getCredits = (slug: string) =>
		call(createOrgCreditsApiHandler, `/@${slug}/-/credits.json`)
	const lastInput = () => mocks.loadOrgCreditsData.mock.lastCall?.[0]

	for (const [person, canReadBilling] of [
		['ada', true],
		['cara', true],
		['bob', false],
	] as const) {
		signInAs(person)
		expect((await getCredits('acme')).status).toBe(200)
		expect(lastInput()).toMatchObject({
			org: {
				id: 'org-acme',
				slug: 'acme',
				displayName: 'Acme',
				personal: false,
			},
			viewerUserId: people[person].personId,
			canReadBilling,
			before: null,
		})
	}

	signInAs('ada')
	await getCredits('ada')
	expect(lastInput()).toMatchObject({
		org: { id: 'person-ada', slug: 'ada', personal: true },
		canReadBilling: true,
	})

	mocks.loadOrgCreditsData.mockClear()
	signInAs('dan')
	expect((await getCredits('acme')).status).toBe(404)
	signInAs('bob')
	expect((await getCredits('ada')).status).toBe(404)
	signInAs(null)
	expect((await getCredits('acme')).status).toBe(401)
	expect(mocks.loadOrgCreditsData).not.toHaveBeenCalled()
})

test('the page renders the same data and 404s outsiders', async () => {
	signInAs('bob')
	const member = await call(createOrgCreditsHandler, '/@acme/-/credits')
	expect(member.status).toBe(200)
	expect(await member.json()).toMatchObject({
		loaderData: { orgCredits: { ok: true, input: { canReadBilling: false } } },
	})

	signInAs('dan')
	const outsider = await call(createOrgCreditsHandler, '/@acme/-/credits')
	expect(outsider.status).toBe(404)
	expect(await outsider.json()).toMatchObject({ notFound: true })

	signInAs(null)
	const signedOut = await call(createOrgCreditsHandler, '/@acme/-/credits')
	expect(signedOut.status).toBe(302)
})

test('a ledger cursor is decoded; a malformed one is a 400 (API) or dropped (page)', async () => {
	const cursor = encodeCreditLedgerCursor({
		createdAt: '2026-10-01T00:00:00.000Z',
		id: 'topup-1',
	})
	await call(
		createOrgCreditsApiHandler,
		`/@acme/-/credits.json?cursor=${encodeURIComponent(cursor)}`,
	)
	expect(mocks.loadOrgCreditsData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			before: { createdAt: '2026-10-01T00:00:00.000Z', id: 'topup-1' },
		}),
	)

	mocks.loadOrgCreditsData.mockClear()
	const bad = await call(
		createOrgCreditsApiHandler,
		'/@acme/-/credits.json?cursor=nope',
	)
	expect(bad.status).toBe(400)
	const page = await call(
		createOrgCreditsHandler,
		'/@acme/-/credits?cursor=nope&x=1',
	)
	expect(page.status).toBe(302)
	expect(page.headers.get('Location')).toBe(
		'https://example.com/@acme/-/credits?x=1',
	)
	expect(mocks.loadOrgCreditsData).not.toHaveBeenCalled()
})
