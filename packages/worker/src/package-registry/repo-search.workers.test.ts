import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { insertSavedPackage, searchSavedPackagesByUserId } from './repo.ts'

const userId = 'search-user-1'
const otherUserId = 'search-user-2'

async function ensureSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS saved_packages (
				id TEXT PRIMARY KEY NOT NULL,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kody_id TEXT NOT NULL,
				description TEXT NOT NULL,
				tags_json TEXT NOT NULL DEFAULT '[]',
				search_text TEXT,
				source_id TEXT NOT NULL,
				has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
				hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)`,
		)
		.run()
	await db
		.prepare(`DELETE FROM saved_packages WHERE user_id IN (?, ?)`)
		.bind(userId, otherUserId)
		.run()
}

function buildRow(input: {
	id: string
	userId?: string
	name: string
	kodyId: string
	description?: string
	tags?: Array<string>
	searchText?: string | null
	hasApp?: boolean
	createdAt: string
	updatedAt: string
}) {
	return {
		id: input.id,
		user_id: input.userId ?? userId,
		name: input.name,
		kody_id: input.kodyId,
		description: input.description ?? '',
		tags_json: JSON.stringify(input.tags ?? []),
		search_text: input.searchText ?? null,
		source_id: `source-${input.id}`,
		has_app: input.hasApp ? (1 as const) : (0 as const),
		hidden: 0 as const,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	}
}

test('searchSavedPackagesByUserId scopes, sorts, queries, filters, and pages', async () => {
	await ensureSchema(env.APP_DB)
	await insertSavedPackage(
		env.APP_DB,
		buildRow({
			id: 'search-pkg-a',
			name: '@user/alpha-dashboard',
			kodyId: 'alpha-dashboard',
			description: 'Dashboard app for metrics',
			tags: ['dashboard', 'metrics'],
			hasApp: true,
			createdAt: '2026-01-03T00:00:00.000Z',
			updatedAt: '2026-01-05T00:00:00.000Z',
		}),
	)
	await insertSavedPackage(
		env.APP_DB,
		buildRow({
			id: 'search-pkg-b',
			name: '@user/beta-notifier',
			kodyId: 'beta-notifier',
			description: 'Sends notification emails',
			searchText: 'email digest 100% coverage',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-06T00:00:00.000Z',
		}),
	)
	await insertSavedPackage(
		env.APP_DB,
		buildRow({
			id: 'search-pkg-c',
			name: '@user/gamma-sync',
			kodyId: 'gamma-sync',
			description: 'Syncs calendars',
			tags: ['calendar'],
			createdAt: '2026-01-02T00:00:00.000Z',
			updatedAt: '2026-01-04T00:00:00.000Z',
		}),
	)
	await insertSavedPackage(
		env.APP_DB,
		buildRow({
			id: 'search-pkg-other',
			userId: otherUserId,
			name: '@other/alpha-dashboard',
			kodyId: 'alpha-dashboard',
			description: 'Dashboard app for metrics',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-07T00:00:00.000Z',
		}),
	)

	const byUpdated = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		limit: 10,
		offset: 0,
	})
	expect(byUpdated.total).toBe(3)
	expect(byUpdated.items.map((item) => item.id)).toEqual([
		'search-pkg-b',
		'search-pkg-a',
		'search-pkg-c',
	])

	const byCreated = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		sort: 'created',
		limit: 10,
		offset: 0,
	})
	expect(byCreated.items.map((item) => item.id)).toEqual([
		'search-pkg-a',
		'search-pkg-c',
		'search-pkg-b',
	])

	const byName = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		sort: 'name',
		limit: 10,
		offset: 0,
	})
	expect(byName.items.map((item) => item.name)).toEqual([
		'@user/alpha-dashboard',
		'@user/beta-notifier',
		'@user/gamma-sync',
	])

	const byNameQuery = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		query: 'ALPHA-DASH',
		limit: 10,
		offset: 0,
	})
	expect(byNameQuery.items.map((item) => item.id)).toEqual(['search-pkg-a'])

	const bySearchText = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		query: 'digest',
		limit: 10,
		offset: 0,
	})
	expect(bySearchText.items.map((item) => item.id)).toEqual(['search-pkg-b'])

	const byTag = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		query: 'calendar',
		limit: 10,
		offset: 0,
	})
	expect(byTag.items.map((item) => item.id)).toEqual(['search-pkg-c'])

	const literalPercent = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		query: '100%',
		limit: 10,
		offset: 0,
	})
	expect(literalPercent.items.map((item) => item.id)).toEqual(['search-pkg-b'])

	const wildcardOnly = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		query: '%',
		limit: 10,
		offset: 0,
	})
	expect(wildcardOnly.total).toBe(1)

	const withApp = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		hasApp: true,
		limit: 10,
		offset: 0,
	})
	expect(withApp.total).toBe(1)
	expect(withApp.items.map((item) => item.id)).toEqual(['search-pkg-a'])

	const withoutApp = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		hasApp: false,
		limit: 10,
		offset: 0,
	})
	expect(withoutApp.total).toBe(2)

	const pageTwo = await searchSavedPackagesByUserId(env.APP_DB, {
		userId,
		limit: 2,
		offset: 2,
	})
	expect(pageTwo.total).toBe(3)
	expect(pageTwo.items.map((item) => item.id)).toEqual(['search-pkg-c'])
})
