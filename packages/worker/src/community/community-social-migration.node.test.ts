import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

test('community social migration defaults profiles public, packages private, and backfills activity', () => {
	const db = new DatabaseSync(':memory:')
	applyMigration(db, '0001-init.sql')
	applyMigration(db, '0027-saved-packages.sql')
	applyMigration(db, '0045-community-listings.sql')
	applyMigration(db, '0052-stable-user-id-email-changes.sql')
	applyMigration(db, '0058-saved-packages-hidden.sql')

	db.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES (?, ?, ?, ?)`,
	).run('alice', 'alice@example.com', 'hash', 'stable-alice')

	db.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'pkg-1',
		'stable-alice',
		'@alice/notes',
		'notes',
		'Notes package',
		'[]',
		null,
		'source-1',
		0,
		0,
	)

	db.prepare(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, published_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		'listing-1',
		'stable-alice',
		'pkg-1',
		'source-1',
		'notes',
		'@alice/notes',
		'Notes package',
		'[]',
		'MIT',
		'commit-1',
		'active',
		'2026-01-02T00:00:00.000Z',
	)

	applyMigration(db, '0068-community-social.sql')

	expect(
		db
			.prepare(
				`SELECT profile_visibility, display_name, bio FROM users WHERE username = 'alice'`,
			)
			.get(),
	).toEqual({
		profile_visibility: 'public',
		display_name: null,
		bio: null,
	})

	expect(
		db
			.prepare(`SELECT is_private FROM saved_packages WHERE id = 'pkg-1'`)
			.get(),
	).toEqual({ is_private: 1 })

	const activity = db
		.prepare(
			`SELECT actor_user_id, event_type, listing_id, created_at
			FROM community_activity_events
			WHERE listing_id = 'listing-1'`,
		)
		.get() as {
		actor_user_id: string
		event_type: string
		listing_id: string
		created_at: string
	}
	expect(activity).toMatchObject({
		actor_user_id: 'stable-alice',
		event_type: 'listing_published',
		listing_id: 'listing-1',
		created_at: '2026-01-02T00:00:00.000Z',
	})

	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
					'user_follows', 'community_stars', 'community_activity_events'
				) ORDER BY name`,
			)
			.all(),
	).toEqual([
		{ name: 'community_activity_events' },
		{ name: 'community_stars' },
		{ name: 'user_follows' },
	])
})

test('user avatars migration adds nullable avatar_key column', () => {
	const db = new DatabaseSync(':memory:')
	applyMigration(db, '0001-init.sql')

	db.prepare(
		`INSERT INTO users (username, email, password_hash)
		VALUES (?, ?, ?)`,
	).run('alice', 'alice@example.com', 'hash')

	applyMigration(db, '0069-user-avatars.sql')

	expect(
		db.prepare(`SELECT avatar_key FROM users WHERE username = 'alice'`).get(),
	).toEqual({ avatar_key: null })

	db.prepare(`UPDATE users SET avatar_key = ? WHERE username = 'alice'`).run(
		'user-avatars/stable-alice/abcdef.png',
	)

	expect(
		db.prepare(`SELECT avatar_key FROM users WHERE username = 'alice'`).get(),
	).toEqual({ avatar_key: 'user-avatars/stable-alice/abcdef.png' })
})
