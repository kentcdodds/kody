import { expect, test } from './playwright-utils.ts'
import {
	executeE2eD1Command,
	seedCommunityListingInE2eDatabase,
} from './d1-utils.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'

test('profiles, stars, follows, and timeline connect community social activity', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const listingId = `e2e-social-listing-${runId}`
	const listingName = `@social-owner-${runId}/shared-package`
	const owner = await seedE2eUser({
		email: `social-owner-${runId}@example.com`,
		username: `social_owner_${runId}`,
		password: 'social-owner-password',
	})
	const viewer = await seedE2eUser({
		email: `social-viewer-${runId}@example.com`,
		username: `social_viewer_${runId}`,
		password: 'social-viewer-password',
	})

	await seedCommunityListingInE2eDatabase({
		listingId,
		ownerEmail: owner.email,
		name: listingName,
		description: 'Listing seeded for community social e2e coverage.',
		tags: ['social'],
		trusted: true,
	})

	const ownerStableId = await createStableUserIdFromEmail(owner.email)
	executeE2eD1Command(
		`
INSERT INTO community_activity_events (
	id, actor_user_id, event_type, listing_id, created_at
) VALUES (
	${quoteSqlString(`activity-${listingId}`)},
	${quoteSqlString(ownerStableId)},
	'listing_published',
	${quoteSqlString(listingId)},
	CURRENT_TIMESTAMP
);`.trim(),
	)

	await login({
		email: viewer.email,
		password: viewer.password,
		mode: 'login',
	})

	await page.goto(`/@${owner.username}`)
	await expect(page.getByTestId('profile-frame')).toBeVisible()
	await expect(page.getByTestId('profile-username')).toContainText(
		`@${owner.username}`,
	)
	await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()

	await page.goto(`/community/${listingId}`)
	await expect(page.getByTestId('community-star')).toBeVisible()
	await page.getByRole('button', { name: 'Star', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Unstar' })).toBeVisible()
	await expect(page.getByTestId('community-stargazers')).toContainText(
		viewer.username,
	)

	await page.goto(`/@${owner.username}`)
	await page.getByRole('button', { name: 'Follow' }).click()
	await expect(page.getByRole('button', { name: 'Unfollow' })).toBeVisible()

	await page.goto('/timeline')
	await expect(page.getByTestId('timeline-page')).toBeVisible()
	await expect(page.getByRole('link', { name: listingName })).toBeVisible()
})
