import {
	collectJsonRequests,
	expectSingleCommitTransition,
	observeMainTransitions,
	readMainTransitions,
} from './main-transitions.ts'
import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

/**
 * Account and admin pages sit in a persistent shell; moving between them is
 * tab switching. Each hop must replace the previous page in one commit: the
 * heading never disappears, no "Loading…" copy takes the content's place,
 * and the destination payload the router preloaded is never fetched twice.
 */
async function clickThroughSections(
	page: Page,
	navName: string,
	hops: Array<{ link: string; heading: string | RegExp }>,
	fromHeading: string | RegExp,
) {
	const requests = collectJsonRequests(page)
	let previousHeading = fromHeading
	for (const hop of hops) {
		requests.reset()
		await observeMainTransitions(page)
		await page
			.getByRole('navigation', { name: navName })
			.getByRole('link', { name: hop.link, exact: true })
			.click()
		await expect(
			page.getByRole('heading', { level: 1, name: hop.heading }),
		).toBeVisible()
		// Let any stray follow-up render land before reading the log.
		await page.waitForTimeout(250)
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: previousHeading,
			toHeading: hop.heading,
		})
		expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
		previousHeading = hop.heading
	}
}

test('account section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-nav-${runId}@example.com`,
		username: `account-nav-${runId}`,
		password: 'account-nav-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account/jobs')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Jobs' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Account sections',
		[
			{ link: 'Memories', heading: 'Memories' },
			{ link: 'Secrets', heading: 'Secrets' },
			{ link: 'Workflows', heading: 'Workflows' },
			{ link: 'Overview', heading: 'Account' },
			{ link: 'Jobs', heading: 'Jobs' },
		],
		'Jobs',
	)
})

test('admin section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `admin-nav-${runId}@example.com`,
		username: `admin-nav-${runId}`,
		password: 'admin-nav-password',
	})
	await assignRole(adminUser.email, 'admin')
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/roles')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Admin roles' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Admin sections',
		[
			{ link: 'Invites', heading: 'Admin invites' },
			{ link: 'Feature flags', heading: 'Admin feature flags' },
			{ link: 'Roles', heading: 'Admin roles' },
		],
		'Admin roles',
	)
})
