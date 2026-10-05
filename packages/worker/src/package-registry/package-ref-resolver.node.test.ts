import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { retirePackageSlug } from '#worker/community/package-url.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listSavedPackagesBySlugs,
	resolveSavedPackageRef,
	resolveSavedPackageRefWithCommunityProvenance,
} from './repo.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const ownerId = 'owner-user'
const otherOwnerId = 'other-user'
const notesId = '6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	function insertPackage(input: { id: string; userId: string; name: string }) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, tags_json, source_id,
					has_app, hidden, is_private, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', '[]', ?, 0, 0, 1, ?, ?)`,
			)
			.run(
				input.id,
				input.userId,
				input.name,
				input.name.slice(input.name.indexOf('/') + 1),
				`source-${input.id}`,
				'2026-10-05T00:00:00.000Z',
				'2026-10-05T00:00:00.000Z',
			)
	}
	function renamePackage(id: string, name: string) {
		sqlite
			.prepare(`UPDATE saved_packages SET name = ?, kody_id = ? WHERE id = ?`)
			.run(name, name.slice(name.indexOf('/') + 1), id)
	}
	return { db, sqlite, insertPackage, renamePackage }
}

async function idOf(
	db: D1Database,
	input: Parameters<typeof resolveSavedPackageRef>[1],
) {
	return (await resolveSavedPackageRef(db, input))?.id ?? null
}

test('resolveSavedPackageRef accepts a leaf, @scope/leaf, or package UUID for one owner', async () => {
	const { db, insertPackage } = createDb()
	insertPackage({ id: notesId, userId: ownerId, name: '@owner/notes' })
	insertPackage({
		id: 'other-notes',
		userId: otherOwnerId,
		name: '@other/notes',
	})

	const refs: Array<[ref: string, expected: string | null]> = [
		['notes', notesId],
		['  notes  ', notesId],
		['@owner/notes', notesId],
		['@Owner/notes', notesId],
		[notesId, notesId],
		['@other/notes', null],
		['other-notes', null],
		['missing', null],
		['@owner/missing', null],
		['@owner', null],
		['', null],
	]
	for (const [ref, expected] of refs) {
		expect({ ref, id: await idOf(db, { userId: ownerId, ref }) }).toEqual({
			ref,
			id: expected,
		})
	}

	// `match: 'slug'` is for URL path segments: only the name leaf matches.
	await expect(
		idOf(db, { userId: ownerId, ref: 'notes', match: 'slug' }),
	).resolves.toBe(notesId)
	for (const ref of [notesId, '@owner/notes']) {
		await expect(
			idOf(db, { userId: ownerId, ref, match: 'slug' }),
		).resolves.toBeNull()
	}

	await expect(
		resolveSavedPackageRefWithCommunityProvenance(db, {
			userId: ownerId,
			ref: '@owner/notes',
		}),
	).resolves.toMatchObject({ id: notesId, sourceListingId: null })
	await expect(
		listSavedPackagesBySlugs(db, {
			userId: ownerId,
			slugs: ['notes', 'missing'],
		}),
	).resolves.toEqual([expect.objectContaining({ id: notesId })])
})

test('a UUID match wins over a package whose slug spells the same string', async () => {
	const { db, insertPackage } = createDb()
	insertPackage({ id: notesId, userId: ownerId, name: '@owner/notes' })
	insertPackage({
		id: 'uuid-slug',
		userId: ownerId,
		name: `@owner/${notesId}`,
	})
	await expect(idOf(db, { userId: ownerId, ref: notesId })).resolves.toBe(
		notesId,
	)
	await expect(
		idOf(db, { userId: ownerId, ref: notesId, match: 'slug' }),
	).resolves.toBe('uuid-slug')
})

test('resolveSavedPackageRef follows slug redirects only when asked and never past a live slug', async () => {
	const { db, sqlite, insertPackage, renamePackage } = createDb()
	insertPackage({ id: notesId, userId: ownerId, name: '@owner/notes' })
	renamePackage(notesId, '@owner/journal')
	await retirePackageSlug({
		db,
		userId: ownerId,
		packageId: notesId,
		oldSlug: 'notes',
		newSlug: 'journal',
	})

	await expect(idOf(db, { userId: ownerId, ref: 'notes' })).resolves.toBeNull()
	for (const ref of ['notes', '@owner/notes']) {
		await expect(
			idOf(db, { userId: ownerId, ref, followRedirects: true }),
		).resolves.toBe(notesId)
	}
	await expect(
		idOf(db, { userId: ownerId, ref: '@someone/notes', followRedirects: true }),
	).resolves.toBeNull()
	await expect(
		idOf(db, { userId: otherOwnerId, ref: 'notes', followRedirects: true }),
	).resolves.toBeNull()

	// Rows that only exist in the legacy table still resolve.
	sqlite.exec(`DELETE FROM package_slug_redirects`)
	await expect(
		idOf(db, { userId: ownerId, ref: 'notes', followRedirects: true }),
	).resolves.toBe(notesId)

	// A live package that owns the slug wins over the retirement row.
	insertPackage({ id: 'new-notes', userId: ownerId, name: '@owner/notes' })
	await expect(
		idOf(db, { userId: ownerId, ref: 'notes', followRedirects: true }),
	).resolves.toBe('new-notes')
})
