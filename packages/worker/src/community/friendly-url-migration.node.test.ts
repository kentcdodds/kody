import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0009-community-listing-friendly-urls.sql'

function applyMigrationsBeforeFriendlyUrls(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(fileName) => fileName.endsWith('.sql') && fileName < migrationFileName,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function insertPackage(
	db: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	db.prepare(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES (?, ?, ?, ?, '', ?)`,
	).run(
		input.id,
		input.userId,
		`@owner/${input.kodyId}`,
		input.kodyId,
		input.id,
	)
}

function insertListing(
	db: DatabaseSync,
	input: {
		id: string
		ownerUserId: string
		packageId: string
		kodyId: string
		updatedAt: string
	},
) {
	db.prepare(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			license, pinned_commit, status, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, '', 'MIT', 'commit', 'active', ?)`,
	).run(
		input.id,
		input.ownerUserId,
		input.packageId,
		input.packageId,
		input.kodyId,
		`@owner/${input.kodyId}`,
		input.updatedAt,
	)
}

function applyFriendlyUrlMigration(db: DatabaseSync) {
	db.exec(readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'))
}

function readStatuses(db: DatabaseSync) {
	return Object.fromEntries(
		db
			.prepare(`SELECT id, status FROM community_listings ORDER BY id`)
			.all()
			.map((row) => [String(row['id']), String(row['status'])]),
	)
}

function readKodyIds(db: DatabaseSync) {
	return Object.fromEntries(
		db
			.prepare(`SELECT id, kody_id FROM community_listings ORDER BY id`)
			.all()
			.map((row) => [String(row['id']), String(row['kody_id'])]),
	)
}

test('canonical-url collisions are resolved so the unique index can be created', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeFriendlyUrls(db)

	// Collision between a deleted package's leftover listing and a live one.
	insertPackage(db, { id: 'pkg-live', userId: 'user-1', kodyId: 'orphaned' })
	insertListing(db, {
		id: 'listing-orphan',
		ownerUserId: 'user-1',
		packageId: 'pkg-gone',
		kodyId: 'orphaned',
		updatedAt: '2026-01-01T00:00:00Z',
	})
	insertListing(db, {
		id: 'listing-live',
		ownerUserId: 'user-1',
		packageId: 'pkg-live',
		kodyId: 'orphaned',
		updatedAt: '2024-01-01T00:00:00Z',
	})

	// Collision between two live packages: one edited its `kody.id` away without
	// republishing, the other published under the freed id.
	insertPackage(db, { id: 'pkg-drifted', userId: 'user-1', kodyId: 'renamed' })
	insertPackage(db, {
		id: 'pkg-claimed',
		userId: 'user-1',
		kodyId: 'contested',
	})
	insertListing(db, {
		id: 'listing-drifted',
		ownerUserId: 'user-1',
		packageId: 'pkg-drifted',
		kodyId: 'contested',
		updatedAt: '2026-01-01T00:00:00Z',
	})
	insertListing(db, {
		id: 'listing-claimed',
		ownerUserId: 'user-1',
		packageId: 'pkg-claimed',
		kodyId: 'contested',
		updatedAt: '2024-01-01T00:00:00Z',
	})

	// Same pair under a different owner, and an uncontested listing: untouched.
	insertPackage(db, { id: 'pkg-other', userId: 'user-2', kodyId: 'contested' })
	insertListing(db, {
		id: 'listing-other-owner',
		ownerUserId: 'user-2',
		packageId: 'pkg-other',
		kodyId: 'contested',
		updatedAt: '2024-01-01T00:00:00Z',
	})
	insertPackage(db, { id: 'pkg-solo', userId: 'user-1', kodyId: 'solo' })
	insertListing(db, {
		id: 'listing-alone',
		ownerUserId: 'user-1',
		packageId: 'pkg-solo',
		kodyId: 'solo',
		updatedAt: '2024-01-01T00:00:00Z',
	})

	expect(() => applyFriendlyUrlMigration(db)).not.toThrow()

	expect(readStatuses(db)).toEqual({
		'listing-orphan': 'delisted',
		'listing-live': 'active',
		// The drifted listing keeps its page at the id its package actually has:
		// nothing can relist a delisted listing, so a live package must not lose.
		'listing-drifted': 'active',
		'listing-claimed': 'active',
		'listing-other-owner': 'active',
		'listing-alone': 'active',
	})
	expect(readKodyIds(db)).toMatchObject({
		'listing-drifted': 'renamed',
		'listing-claimed': 'contested',
	})
})

test('a drifted listing is delisted when its package id is taken too', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeFriendlyUrls(db)
	// `pkg-drifted` moved to `taken`, which another published package already
	// holds, so there is no free id to repair the listing onto.
	insertPackage(db, { id: 'pkg-drifted', userId: 'user-1', kodyId: 'taken' })
	insertPackage(db, { id: 'pkg-holder', userId: 'user-1', kodyId: 'holder' })
	insertPackage(db, {
		id: 'pkg-claimed',
		userId: 'user-1',
		kodyId: 'contested',
	})
	insertListing(db, {
		id: 'listing-drifted',
		ownerUserId: 'user-1',
		packageId: 'pkg-drifted',
		kodyId: 'contested',
		updatedAt: '2026-01-01T00:00:00Z',
	})
	insertListing(db, {
		id: 'listing-claimed',
		ownerUserId: 'user-1',
		packageId: 'pkg-claimed',
		kodyId: 'contested',
		updatedAt: '2024-01-01T00:00:00Z',
	})
	insertListing(db, {
		id: 'listing-holder',
		ownerUserId: 'user-1',
		packageId: 'pkg-holder',
		kodyId: 'taken',
		updatedAt: '2024-01-01T00:00:00Z',
	})

	expect(() => applyFriendlyUrlMigration(db)).not.toThrow()

	expect(readStatuses(db)).toEqual({
		'listing-drifted': 'delisted',
		'listing-claimed': 'active',
		'listing-holder': 'active',
	})
})

test('a listing whose package is gone keeps the URL when nothing competes for it', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeFriendlyUrls(db)
	insertListing(db, {
		id: 'listing-orphan',
		ownerUserId: 'user-1',
		packageId: 'pkg-gone',
		kodyId: 'snapshot',
		updatedAt: '2026-01-01T00:00:00Z',
	})

	applyFriendlyUrlMigration(db)

	expect(readStatuses(db)).toEqual({ 'listing-orphan': 'active' })
})
