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
				has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
				hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
				is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
				locked_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)`,
		)
		.run()
	for (const column of [
		'is_private INTEGER NOT NULL DEFAULT 1',
		'locked_at TEXT',
	]) {
		try {
			await db.prepare(`ALTER TABLE saved_packages ADD COLUMN ${column}`).run()
		} catch {
			// Column already present on newer schemas.
		}
	}
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
		has_skills: 0 as const,
		hidden: 0 as const,
		is_private: 0 as const,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	}
}

type SearchInput = Omit<
	Parameters<typeof searchSavedPackagesByUserId>[1],
	'userId' | 'limit' | 'offset'
> & { limit?: number; offset?: number }

test('searchSavedPackagesByUserId scopes, sorts, queries, filters, and pages', async () => {
	await ensureSchema(env.APP_DB)
	for (const row of [
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
		buildRow({
			id: 'search-pkg-b',
			name: '@user/beta-notifier',
			kodyId: 'beta-notifier',
			description: 'Sends notification emails',
			searchText: 'email digest 100% coverage',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-06T00:00:00.000Z',
		}),
		buildRow({
			id: 'search-pkg-c',
			name: '@user/gamma-sync',
			kodyId: 'gamma-sync',
			description: 'Syncs calendars',
			tags: ['calendar'],
			createdAt: '2026-01-02T00:00:00.000Z',
			updatedAt: '2026-01-04T00:00:00.000Z',
		}),
		buildRow({
			id: 'search-pkg-other',
			userId: otherUserId,
			name: '@other/alpha-dashboard',
			kodyId: 'alpha-dashboard',
			description: 'Dashboard app for metrics',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-07T00:00:00.000Z',
		}),
	]) {
		await insertSavedPackage(env.APP_DB, row)
	}

	const cases: Array<[input: SearchInput, total: number, ids: Array<string>]> =
		[
			[{}, 3, ['search-pkg-b', 'search-pkg-a', 'search-pkg-c']],
			[
				{ sort: 'created' },
				3,
				['search-pkg-a', 'search-pkg-c', 'search-pkg-b'],
			],
			[{ sort: 'name' }, 3, ['search-pkg-a', 'search-pkg-b', 'search-pkg-c']],
			[{ query: 'ALPHA-DASH' }, 1, ['search-pkg-a']],
			[{ query: 'digest' }, 1, ['search-pkg-b']],
			[{ query: 'calendar' }, 1, ['search-pkg-c']],
			[{ query: '100%' }, 1, ['search-pkg-b']],
			[{ query: '%' }, 1, ['search-pkg-b']],
			[{ hasApp: true }, 1, ['search-pkg-a']],
			[{ hasApp: false }, 2, ['search-pkg-b', 'search-pkg-c']],
			[{ limit: 2, offset: 2 }, 3, ['search-pkg-c']],
		]
	for (const [input, total, ids] of cases) {
		const result = await searchSavedPackagesByUserId(env.APP_DB, {
			userId,
			limit: 10,
			offset: 0,
			...input,
		})
		expect({
			input,
			total: result.total,
			ids: result.items.map((i) => i.id),
		}).toEqual({ input, total, ids })
	}
})
