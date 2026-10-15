import { expect, test } from './playwright-utils.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'

/**
 * Internet-visible package apps (ADR 0069) serve signed-out visitors without
 * a login redirect; private apps keep asking for login. The seeded apps have
 * no published source, so a request that clears the access gate ends in the
 * "could not be prepared" page — which is exactly the proof that it was let
 * through rather than sent to /login.
 */
test('a signed-out visitor reaches an internet-visible app; a private app still asks for login', async ({
	page,
	seedE2eUser,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `pkg-public-owner-${runId}@example.com`,
		username: `pkgpublicowner${runId}`.slice(0, 32),
		password: 'pkg-public-owner-password',
	})
	const ownerIdSql = `(SELECT stable_user_id FROM users WHERE email = ${quoteSqlString(owner.email)})`
	const now = new Date().toISOString()
	const apps = {
		public: { kodyId: `public-demo-${runId}`, internetVisible: 1 },
		private: { kodyId: `private-demo-${runId}`, internetVisible: 0 },
	}
	for (const app of Object.values(apps)) {
		executeE2eD1Command(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, is_private, is_internet_visible,
				created_at, updated_at
			) VALUES (
				${quoteSqlString(crypto.randomUUID())},
				${ownerIdSql},
				${quoteSqlString(`@${owner.username}/${app.kodyId}`)},
				${quoteSqlString(app.kodyId)},
				${quoteSqlString('Internet-visible serving E2E')},
				'[]',
				NULL,
				${quoteSqlString(crypto.randomUUID())},
				1,
				0,
				1,
				${app.internetVisible},
				${quoteSqlString(now)},
				${quoteSqlString(now)}
			)`,
		)
	}

	const publicResponse = await page.request.get(
		`/@${owner.username}/packages/${apps.public.kodyId}`,
		{ maxRedirects: 0, headers: { Accept: 'application/json' } },
	)
	expect(publicResponse.headers()['location']).toBeUndefined()
	expect(publicResponse.headers()['vary']).toContain('Cookie')
	await expect(publicResponse.json()).resolves.toMatchObject({
		error: 'Package app could not be prepared',
	})

	const privateResponse = await page.request.get(
		`/@${owner.username}/packages/${apps.private.kodyId}`,
		{ maxRedirects: 0 },
	)
	expect(privateResponse.status()).toBe(302)
	expect(privateResponse.headers()['location']).toContain('/login')
})
