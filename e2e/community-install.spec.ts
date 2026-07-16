import { expect, test } from './playwright-utils.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

// The local e2e worker has no Cloudflare Artifacts persistence, so a
// confirmed install submits the request end-to-end but the server responds
// with its handled failure. These tests cover the auth and acknowledgement
// gates plus the client warning flow; the full fork-and-publish path is
// covered by community-flow.workers.test.ts against mock Artifacts.
test('one-click install gates untrusted listings behind a warning and auth', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const listingId = `e2e-install-untrusted-${runId}`
	const memberUser = await seedE2eUser({
		email: `install-member-${runId}@example.com`,
		username: `install-member-${runId}`,
		password: 'install-member-password',
	})
	await seedCommunityListingInE2eDatabase({
		listingId,
		ownerEmail: memberUser.email,
		name: `@kody/install-untrusted-${runId}`,
		description: 'Listing seeded for the untrusted install e2e test.',
		tags: ['install'],
	})

	// Anonymous visitors see a login link instead of the install button, and
	// the endpoint rejects unauthenticated posts.
	await page.goto(`/community/${listingId}`)
	const installCard = page.getByTestId('community-install')
	await expect(installCard).toBeVisible()
	await expect(installCard.getByRole('link', { name: 'Log in' })).toBeVisible()
	await expect(
		installCard.getByRole('button', { name: 'Install', exact: true }),
	).toHaveCount(0)
	const anonymousResponse = await page.request.post(
		`/community/${listingId}/install.json`,
		{
			data: { acknowledged_untrusted: true },
			headers: { 'Content-Type': 'application/json' },
		},
	)
	expect(anonymousResponse.status()).toBe(401)

	// Logged-in members must acknowledge the untrusted warning; the server
	// enforces the same gate for direct API calls.
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	const unacknowledgedResponse = await page.request.post(
		`/community/${listingId}/install.json`,
		{
			data: {},
			headers: { 'Content-Type': 'application/json' },
		},
	)
	expect(unacknowledgedResponse.status()).toBe(409)
	expect(await unacknowledgedResponse.json()).toMatchObject({
		ok: false,
		requiresAcknowledgement: true,
	})

	await page.goto(`/community/${listingId}`)
	await installCard
		.getByRole('button', { name: 'Install', exact: true })
		.click()
	await expect(page.getByTestId('community-install-warning')).toBeVisible()
	await installCard.getByRole('button', { name: 'Cancel' }).click()
	await expect(page.getByTestId('community-install-warning')).toHaveCount(0)

	// Confirming submits the acknowledged install request to the server.
	await installCard
		.getByRole('button', { name: 'Install', exact: true })
		.click()
	const [confirmedResponse] = await Promise.all([
		page.waitForResponse((response) =>
			response.url().includes(`/community/${listingId}/install.json`),
		),
		installCard.getByRole('button', { name: 'Install anyway' }).click(),
	])
	expect(confirmedResponse.status()).toBe(500)
	await expect(installCard.getByRole('alert')).toContainText(
		'Unable to install',
	)
})

test('trusted listings install without the untrusted warning', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const listingId = `e2e-install-trusted-${runId}`
	const memberUser = await seedE2eUser({
		email: `install-trusted-${runId}@example.com`,
		username: `install-trusted-${runId}`,
		password: 'install-trusted-password',
	})
	await seedCommunityListingInE2eDatabase({
		listingId,
		ownerEmail: memberUser.email,
		name: `@kody/install-trusted-${runId}`,
		description: 'Listing seeded for the trusted install e2e test.',
		tags: ['install'],
		trusted: true,
	})

	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${listingId}`)
	const installCard = page.getByTestId('community-install')
	await expect(installCard).toContainText(
		'An admin reviewed and trusted this exact version.',
	)
	const [response] = await Promise.all([
		page.waitForResponse((res) =>
			res.url().includes(`/community/${listingId}/install.json`),
		),
		installCard.getByRole('button', { name: 'Install', exact: true }).click(),
	])
	// No warning step for trusted listings; the request goes straight out.
	await expect(page.getByTestId('community-install-warning')).toHaveCount(0)
	expect(response.status()).toBe(500)
})
