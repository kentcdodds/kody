import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

test('team org usage shows members only their own connections, and owners the whole org', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const slug = `usage-team-${runId}`
	const owner = await seedE2eUser({
		email: `usage-owner-${runId}@example.com`,
		username: `usage-owner-${runId}`,
		password: 'usage-owner-password',
	})
	const member = await seedE2eUser({
		email: `usage-member-${runId}@example.com`,
		username: `usage-member-${runId}`,
		password: 'usage-member-password',
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const memberId = seedStableUserIdFromEmail(member.email)
	const teamId = `org-usage-${runId}`
	const day = new Date().toISOString().slice(0, 10)
	const usageRow = (
		orgId: string,
		[kind, holder, credential]: [string, string, string],
		units: number,
	) =>
		`(${[orgId, day, kind, holder, credential, '', 'execute']
			.map(sqlString)
			.join(', ')}, ${units})`
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
VALUES (${sqlString(teamId)}, ${sqlString(slug)}, 'Usage Team', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
	(${sqlString(teamId)}, ${sqlString(ownerId)}, 'owner', CURRENT_TIMESTAMP),
	(${sqlString(teamId)}, ${sqlString(memberId)}, 'member', CURRENT_TIMESTAMP);
INSERT INTO usage_connection_daily (
	user_id, day, credential_kind, holder_user_id, credential_id,
	package_id, event_type, units
) VALUES
	${usageRow(teamId, ['mcp-oauth', memberId, 'https://slack-bot.example/client.json'], 1440)},
	${usageRow(teamId, ['api-token', ownerId, 'tok_owner_private'], 9)},
	${usageRow(teamId, ['schedule', '', 'job-poll'], 30)},
	${usageRow(memberId, ['cli', memberId, ''], 77)};
`)

	// A member sees their own team connection, not the owner's token,
	// Automation, or their personal-org CLI usage.
	await login({ email: member.email, password: member.password, mode: 'login' })
	const response = await page.goto(`/@${slug}/-/connections`)
	expect(response?.status()).toBe(200)
	await waitForClientHydration(page)
	const summary = page.getByTestId('connection-usage-summary-table')
	await expect(summary).toContainText('slack-bot.example')
	await expect(summary).toContainText('1,440')
	await expect(summary).not.toContainText('Kody CLI')
	await expect(summary).not.toContainText('API token')
	await page.getByTestId('connection-usage-details-link').click()
	await expect(page).toHaveURL(new RegExp(`/@${slug}/-/connections/usage$`))
	await expect(page.getByTestId('connection-usage-own-only')).toBeVisible()
	await expect(page.getByTestId('connection-usage-entry')).toHaveCount(1)
	await expect(page.getByTestId('connection-usage-automations')).toHaveCount(0)
	await expect(page.getByTestId('connection-usage-people')).toHaveCount(0)
	await expect(page.locator('body')).not.toContainText('tok_owner_private')

	// The same member's personal Connections page shows only personal usage.
	await page.goto(`/@${member.username}/-/connections`)
	await waitForClientHydration(page)
	await expect(
		page.getByTestId('connection-usage-summary-table'),
	).toContainText('Kody CLI')
	await expect(
		page.getByTestId('connection-usage-summary-table'),
	).not.toContainText('slack-bot.example')

	// The owner also sees Automation and the member by username only.
	await page.context().clearCookies()
	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${slug}/-/connections/usage`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('connection-usage-own-only')).toHaveCount(0)
	await expect(page.getByTestId('connection-usage-automations')).toContainText(
		'30',
	)
	const people = page.getByTestId('connection-usage-people')
	await expect(people).toContainText(`@${member.username}`)
	await expect(people).toContainText('1,440')
	await expect(people).not.toContainText('slack-bot.example')
})
