import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { parseSiteBannerInput } from '#universal/site-banners.ts'
import {
	deleteSiteBanner,
	dismissSiteBannerForUser,
	listDismissedBannerIds,
	listEnabledSiteBanners,
	listSiteBannersForAdmin,
	saveSiteBanner,
} from './service.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const adminEmail = 'admin@example.com'
	const adminStableId = testStableUserIdFromEmail(adminEmail)
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'admin-user',
			${quoteSqlString(adminEmail)},
			${quoteSqlString(adminStableId)},
			'oauth_created_no_usable_password'
		);
	`)
	const userId = sqlite
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.get(adminEmail) as { id: number }
	return { sqlite, db: createD1FromSqlite(sqlite), userId: userId.id }
}

function launchInput(overrides: Record<string, unknown> = {}) {
	const parsed = parseSiteBannerInput({
		enabled: true,
		priority: 20,
		title: 'Kody is live',
		body: 'Watch the launch video.',
		ctaHref: 'https://example.com/kody-launch-video',
		ctaLabel: 'Watch the video',
		secondaryHref: '/blog',
		secondaryLabel: 'Read the announcement',
		severity: 'promo',
		look: 'promo',
		icon: 'play',
		pageTargeting: 'all',
		audience: 'everyone',
		dismissible: true,
		...overrides,
	})
	if (!parsed.ok) throw new Error(parsed.error)
	return parsed.value
}

test('site banner service: save, list enabled vs admin, dismiss, delete', async () => {
	const { db, userId } = createMigratedDb()

	const saved = await saveSiteBanner(db, {
		banner: launchInput(),
		actorUserId: userId,
	})
	expect(saved.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	)
	expect(saved.look).toBe('promo')
	expect(saved.enabled).toBe(true)

	await saveSiteBanner(db, {
		banner: launchInput({
			enabled: false,
			priority: 50,
			title: 'Disabled winner',
			look: 'card',
		}),
		actorUserId: userId,
	})

	const enabled = await listEnabledSiteBanners(db)
	expect(enabled.map((banner) => banner.title)).toEqual(['Kody is live'])

	const adminList = await listSiteBannersForAdmin(db)
	expect(adminList.map((banner) => banner.title)).toEqual([
		'Disabled winner',
		'Kody is live',
	])

	await dismissSiteBannerForUser(db, { bannerId: saved.id, userId })
	expect(await listDismissedBannerIds(db, userId)).toEqual([saved.id])

	expect(await deleteSiteBanner(db, saved.id)).toBe(true)
	expect(await listDismissedBannerIds(db, userId)).toEqual([])
	expect(await deleteSiteBanner(db, saved.id)).toBe(false)
})
