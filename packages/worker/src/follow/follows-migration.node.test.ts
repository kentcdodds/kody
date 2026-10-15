import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

test('fork backfill stores personal org id and keeps the person as creator', () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			stable_user_id TEXT,
			personal_org_id TEXT
		);
		CREATE TABLE community_listings (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT,
			package_id TEXT,
			name TEXT,
			deleted_at TEXT
		);
		CREATE TABLE community_forks (
			id TEXT PRIMARY KEY,
			listing_id TEXT,
			forker_user_id TEXT,
			created_at TEXT
		);
		INSERT INTO users (stable_user_id, personal_org_id) VALUES
			('person-distinct', 'org-personal'),
			('person-equal', 'person-equal'),
			('person-blank', '   ');
		INSERT INTO community_listings (
			id, owner_user_id, package_id, name, deleted_at
		) VALUES
			('listing-distinct', 'org-owner', 'pkg-distinct', '@ada/notes', NULL),
			('listing-equal', 'org-owner', 'pkg-equal', '@ada/equal', NULL),
			('listing-blank', 'org-owner', 'pkg-blank', '@ada/blank', NULL),
			('listing-legacy', 'org-owner', 'pkg-legacy', '@ada/legacy', NULL),
			('listing-deleted', 'org-owner', 'pkg-deleted', '@ada/gone', '2026-01-01');
		INSERT INTO community_forks (id, listing_id, forker_user_id, created_at) VALUES
			('fork-distinct', 'listing-distinct', 'person-distinct', '2026-10-01T00:00:00.000Z'),
			('fork-equal', 'listing-equal', 'person-equal', '2026-10-01T00:00:00.000Z'),
			('fork-blank', 'listing-blank', 'person-blank', '2026-10-01T00:00:00.000Z'),
			('fork-legacy', 'listing-legacy', 'person-missing', '2026-10-01T00:00:00.000Z'),
			('fork-deleted', 'listing-deleted', 'person-distinct', '2026-10-01T00:00:00.000Z');
	`)
	sqlite.exec(
		readFileSync(
			new URL('../../migrations/0149-follows.sql', import.meta.url),
			'utf8',
		),
	)
	const rows = sqlite
		.prepare(
			`SELECT id, follower_org_id, creator_user_id, target_id
			 FROM follows
			 ORDER BY id`,
		)
		.all() as Array<{
		id: string
		follower_org_id: string
		creator_user_id: string
		target_id: string
	}>
	expect(rows).toEqual([
		{
			id: 'fork-fork-blank',
			follower_org_id: 'person-blank',
			creator_user_id: 'person-blank',
			target_id: 'pkg-blank',
		},
		{
			id: 'fork-fork-distinct',
			follower_org_id: 'org-personal',
			creator_user_id: 'person-distinct',
			target_id: 'pkg-distinct',
		},
		{
			id: 'fork-fork-equal',
			follower_org_id: 'person-equal',
			creator_user_id: 'person-equal',
			target_id: 'pkg-equal',
		},
		{
			id: 'fork-fork-legacy',
			follower_org_id: 'person-missing',
			creator_user_id: 'person-missing',
			target_id: 'pkg-legacy',
		},
	])
})
