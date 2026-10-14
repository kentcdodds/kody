import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'

/**
 * Hosted package-app handoff sends visitors without app:execute to the
 * saved-package page. That page must say "you don't have access" for a
 * signed-in outsider — never the generic "doesn't quite connect" 404.
 *
 * Cross-origin token mint/exchange lives in
 * `package-app-origin.workers.test.ts` (requires PACKAGE_APP_BASE_URL). This
 * E2E locks the user-visible no-access landing that Tanner hit after Continue.
 */
test('a signed-in outsider hitting a private package page sees no-access, not a missing-page 404', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `pkg-access-owner-${runId}@example.com`,
		username: `pkgaccessowner${runId}`.slice(0, 32),
		password: 'pkg-access-owner-password',
	})
	const stranger = await seedE2eUser({
		email: `pkg-access-stranger-${runId}@example.com`,
		username: `pkgaccessstranger${runId}`.slice(0, 32),
		password: 'pkg-access-stranger-password',
	})
	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const kodyId = `private-demo-${runId}`
	const packageName = `@${owner.username}/${kodyId}`
	const now = new Date().toISOString()
	const ownerIdSql = `(SELECT stable_user_id FROM users WHERE email = ${quoteSqlString(owner.email)})`

	executeE2eD1Command(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			${quoteSqlString(packageId)},
			${ownerIdSql},
			${quoteSqlString(packageName)},
			${quoteSqlString(kodyId)},
			${quoteSqlString('Private package for no-access E2E')},
			'[]',
			NULL,
			${quoteSqlString(sourceId)},
			1,
			0,
			1,
			${quoteSqlString(now)},
			${quoteSqlString(now)}
		)`,
	)

	await login({
		email: stranger.email,
		password: stranger.password,
		mode: 'login',
	})

	const response = await page.goto(`/@${owner.username}/${kodyId}`)
	expect(response?.status()).toBe(403)
	await waitForClientHydration(page)

	const noAccess = page.getByTestId('package-no-access-page')
	await expect(noAccess).toBeVisible()
	await expect(
		page.getByRole('heading', { name: "You don't have access" }),
	).toBeVisible()
	await expect(noAccess).toContainText(packageName)
	await expect(noAccess).toContainText(`@${stranger.username}`)
	await expect(
		page.getByRole('link', { name: 'How sharing works' }),
	).toHaveAttribute('href', '/docs/package-sharing')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: "This doesn't quite connect." }),
	).toHaveCount(0)

	// App-origin handoff mount for the same private package must not mint a
	// token for the outsider; it sends them to the package page instead.
	const handoff = await page.request.get(
		`/@${owner.username}/packages/${kodyId}`,
		{ maxRedirects: 0 },
	)
	expect(handoff.status()).toBe(302)
	expect(handoff.headers()['location']).toBe(`/@${owner.username}/${kodyId}`)
})
