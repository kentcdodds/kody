import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	renderAppPage: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mocks.renderAppPage(...args),
}))

const { createOrgOverviewHandler } = await import('./org-overview.ts')

const adaId = 'person-ada'
const bobId = 'person-bob'

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const now = '2026-01-01T00:00:00.000Z'
	for (const [id, slug] of [
		[adaId, 'ada'],
		[bobId, 'bob'],
		['org-acme', 'acme'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, slug, slug, now, now)
	}
	for (const [orgId, userId] of [
		[adaId, adaId],
		[bobId, bobId],
		['org-acme', adaId],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(orgId, userId, now)
	}
	return { APP_DB: db } as unknown as Env
}

async function getOverview(env: Env, orgSlug: string) {
	return createOrgOverviewHandler(env).handler({
		request: new Request(`https://kody.test/@${orgSlug}/-/overview`),
		params: { orgSlug },
	} as never)
}

beforeEach(() => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.renderAppPage.mockReset()
	mocks.renderAppPage.mockImplementation(
		async (input: { title: string; status?: number }) =>
			new Response(input.title, { status: input.status ?? 200 }),
	)
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		username: 'ada-renamed',
		mcpUser: { userId: adaId },
	})
})

test('the signup org overview renders without remembering the org', async () => {
	const response = await getOverview(await createEnv(), 'ada')
	expect(response.status).toBe(200)
	expect(await response.text()).toBe('Overview')
	expect(response.headers.get('Set-Cookie')).toBeNull()
})

test('a team org overview redirects to the team home', async () => {
	const response = await getOverview(await createEnv(), 'acme')
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe('https://kody.test/@acme')
	expect(mocks.renderAppPage).not.toHaveBeenCalled()
})

test('an org you do not belong to is a 404', async () => {
	const response = await getOverview(await createEnv(), 'bob')
	expect(response.status).toBe(404)
})

test('signed-out visitors go to login', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await getOverview(await createEnv(), 'ada')
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toContain('/login')
	expect(mocks.renderAppPage).not.toHaveBeenCalled()
})
