import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0009-community-listing-friendly-urls.sql'
const newer = '2026-01-01T00:00:00Z'
const older = '2024-01-01T00:00:00Z'

type ListingSeed = [
	listingId: string,
	ownerUserId: string,
	packageId: string,
	listingKodyId: string,
	updatedAt: string,
	/** Seeds the saved package with this `kody_id`; omit for a deleted package. */
	packageKodyId?: string,
]

function readMigration(fileName: string) {
	return readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
}

/** Builds a pre-0009 database with the given listings, applies 0009, and returns it. */
function migrate(listings: Array<ListingSeed>) {
	const db = new DatabaseSync(':memory:')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(fileName) => fileName.endsWith('.sql') && fileName < migrationFileName,
		)
		.sort()) {
		db.exec(readMigration(fileName))
	}
	for (const [
		id,
		owner,
		packageId,
		kodyId,
		updatedAt,
		packageKodyId,
	] of listings) {
		if (packageKodyId) {
			db.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
				VALUES (?, ?, ?, ?, '', ?)`,
			).run(
				packageId,
				owner,
				`@owner/${packageKodyId}`,
				packageKodyId,
				packageId,
			)
		}
		db.prepare(
			`INSERT INTO community_listings (
				id, owner_user_id, package_id, source_id, kody_id, name, description,
				license, pinned_commit, status, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, '', 'MIT', 'commit', 'active', ?)`,
		).run(
			id,
			owner,
			packageId,
			packageId,
			kodyId,
			`@owner/${kodyId}`,
			updatedAt,
		)
	}
	expect(() => db.exec(readMigration(migrationFileName))).not.toThrow()
	return db
}

function readColumn(db: DatabaseSync, column: 'status' | 'kody_id') {
	return Object.fromEntries(
		db
			.prepare(`SELECT id, ${column} FROM community_listings ORDER BY id`)
			.all()
			.map((row) => [String(row['id']), String(row[column])]),
	)
}

test('friendly-url migration resolves collisions, repairs drift, and leaves uncontested orphans alone', () => {
	const db = migrate([
		// Collision between a deleted package's leftover listing and a live one.
		['listing-orphan', 'user-1', 'pkg-gone', 'orphaned', newer],
		['listing-live', 'user-1', 'pkg-live', 'orphaned', older, 'orphaned'],
		// Collision between two live packages: one edited its `kody.id` away
		// without republishing, the other published under the freed id.
		['listing-drifted', 'user-1', 'pkg-drifted', 'contested', newer, 'renamed'],
		[
			'listing-claimed',
			'user-1',
			'pkg-claimed',
			'contested',
			older,
			'contested',
		],
		// Same pair under a different owner, and an uncontested listing: untouched.
		[
			'listing-other-owner',
			'user-2',
			'pkg-other',
			'contested',
			older,
			'contested',
		],
		['listing-alone', 'user-1', 'pkg-solo', 'solo', older, 'solo'],
	])
	expect(readColumn(db, 'status')).toEqual({
		'listing-orphan': 'delisted',
		'listing-live': 'active',
		// The drifted listing keeps its page at the id its package actually has:
		// nothing can relist a delisted listing, so a live package must not lose.
		'listing-drifted': 'active',
		'listing-claimed': 'active',
		'listing-other-owner': 'active',
		'listing-alone': 'active',
	})
	expect(readColumn(db, 'kody_id')).toMatchObject({
		'listing-drifted': 'renamed',
		'listing-claimed': 'contested',
	})

	// `pkg-drifted` moved to `taken`, which another published package already
	// holds, so there is no free id to repair the listing onto.
	const blocked = migrate([
		['listing-drifted', 'user-1', 'pkg-drifted', 'contested', newer, 'taken'],
		[
			'listing-claimed',
			'user-1',
			'pkg-claimed',
			'contested',
			older,
			'contested',
		],
		['listing-holder', 'user-1', 'pkg-holder', 'taken', older, 'holder'],
	])
	expect(readColumn(blocked, 'status')).toEqual({
		'listing-drifted': 'delisted',
		'listing-claimed': 'active',
		'listing-holder': 'active',
	})

	const orphanAlone = migrate([
		['listing-orphan', 'user-1', 'pkg-gone', 'snapshot', newer],
	])
	expect(readColumn(orphanAlone, 'status')).toEqual({
		'listing-orphan': 'active',
	})
})
