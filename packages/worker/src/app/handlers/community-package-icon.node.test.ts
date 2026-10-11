import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createCommunityPackageIconHandler } from './community-package-icon.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	resolvePackagePageUrl: vi.fn(),
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	serveIdentityIcon: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolvePackagePageUrl: (...args: Array<unknown>) =>
		mocks.resolvePackagePageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('./identity-icon-response.ts', () => ({
	identityIconNotFound: () => new Response('Not found', { status: 404 }),
	ownerIdentityIconCacheControl: 'private, max-age=31536000, immutable',
	serveIdentityIcon: (...args: Array<unknown>) =>
		mocks.serveIdentityIcon(...args),
}))

const source = {
	id: 'source-1',
	user_id: ownerIdFromStored('owner-1'),
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'repo-1',
	published_commit: 'pub-1',
	indexed_commit: null,
}

const publicPackage = {
	id: 'package-1',
	kodyId: 'notes',
	sourceId: 'source-1',
	hidden: false,
	isPrivate: false,
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const now = '2026-01-01T00:00:00.000Z'
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	for (const personId of ['owner-1', 'other-1']) {
		insertOrg.run(personId, personId, personId, now, now)
		insertMembership.run(personId, personId, 'owner', now)
	}
	insertOrg.run('org-acme', 'acme', 'Acme', now, now)
	insertMembership.run('org-acme', 'owner-1', 'owner', now)
	insertMembership.run('org-acme', 'other-1', 'member', now)
	return { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
}

const env = createEnv()

function callHandler(iconCommit = 'pub-1') {
	const handler = createCommunityPackageIconHandler(env)
	return handler.handler({
		request: new Request(`https://example.com/@kent/notes/icon/${iconCommit}`),
		params: { username: 'kent', kodyId: 'notes', iconCommit },
		url: new URL(`https://example.com/@kent/notes/icon/${iconCommit}`),
	} as never)
}

test('package identity icon serves the published commit for guest-visible packages', async () => {
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: ownerIdFromStored('owner-1'),
		savedPackage: publicPackage,
		listingId: null,
	})
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	mocks.getEntitySourceById.mockResolvedValue(source)
	mocks.serveIdentityIcon.mockResolvedValue(
		new Response('icon', { status: 200 }),
	)

	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(mocks.serveIdentityIcon).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'repo-1',
			iconCommit: 'pub-1',
			includePackageAppIcon: true,
			leafName: 'notes',
			cacheControl: undefined,
		}),
	)
})

test('private package identity icons use a private cache for the owner and 404 for other viewers', async () => {
	const privatePackage = {
		...publicPackage,
		hidden: false,
		isPrivate: true,
	}
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: ownerIdFromStored('owner-1'),
		savedPackage: privatePackage,
		listingId: null,
	})
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('owner-1') },
	})
	mocks.getEntitySourceById.mockResolvedValue(source)
	mocks.serveIdentityIcon.mockResolvedValue(
		new Response('icon', { status: 200 }),
	)

	expect((await callHandler()).status).toBe(200)
	expect(mocks.serveIdentityIcon).toHaveBeenCalledWith(
		expect.objectContaining({
			cacheControl: 'private, max-age=31536000, immutable',
		}),
	)

	// A member without a grant on the package cannot see it.
	mocks.serveIdentityIcon.mockClear()
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('other-1') },
	})
	expect((await callHandler()).status).toBe(404)
	expect(mocks.serveIdentityIcon).not.toHaveBeenCalled()
})

test('package identity icon rejects stale commits and hidden private packages', async () => {
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: ownerIdFromStored('owner-1'),
		savedPackage: { ...publicPackage, hidden: true, isPrivate: true },
		listingId: null,
	})
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	expect((await callHandler()).status).toBe(404)

	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: ownerIdFromStored('owner-1'),
		savedPackage: publicPackage,
		listingId: null,
	})
	mocks.getEntitySourceById.mockResolvedValue(source)
	expect((await callHandler('old-commit')).status).toBe(404)
})

test('private team package icons follow what the viewer can see in the team org', async () => {
	const teamPackage = { ...publicPackage, isPrivate: true }
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'acme',
		kodyId: 'notes',
		userId: ownerIdFromStored('org-acme'),
		savedPackage: teamPackage,
		listingId: null,
	})
	mocks.getEntitySourceById.mockResolvedValue({
		...source,
		user_id: ownerIdFromStored('org-acme'),
	})
	mocks.serveIdentityIcon.mockResolvedValue(
		new Response('icon', { status: 200 }),
	)

	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('owner-1') },
	})
	expect((await callHandler()).status).toBe(200)

	// A member without a grant on the package cannot see it.
	mocks.serveIdentityIcon.mockClear()
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('other-1') },
	})
	expect((await callHandler()).status).toBe(404)
	expect(mocks.serveIdentityIcon).not.toHaveBeenCalled()
})
