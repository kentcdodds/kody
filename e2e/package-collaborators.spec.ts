import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

test('package Collaborators tab adds, changes, and removes internal access', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `collab-owner-${runId}@example.com`,
		username: `collab-owner-${runId}`,
		password: 'collab-owner-password',
	})
	const member = await seedE2eUser({
		email: `collab-member-${runId}@example.com`,
		username: `collab-member-${runId}`,
		password: 'collab-member-password',
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const memberId = seedStableUserIdFromEmail(member.email)
	const orgId = `org-collab-${runId}`
	const orgSlug = `collab-org-${runId}`
	const teamId = `team-collab-${runId}`
	const packageName = `collab-pkg-${runId}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
VALUES (${sqlString(orgId)}, ${sqlString(orgSlug)}, 'Collab Org', ${sqlString(ownerId)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES
	(${sqlString(orgId)}, ${sqlString(ownerId)}, 'owner', ${sqlString(now)}),
	(${sqlString(orgId)}, ${sqlString(memberId)}, 'member', ${sqlString(now)});
INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
VALUES (${sqlString(teamId)}, ${sqlString(orgId)}, 'writers', 'Writers', ${sqlString(now)}, ${sqlString(now)});
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${sqlString(`pkg-collab-${runId}`)}, ${sqlString(orgId)}, ${sqlString(packageName)},
	${sqlString(packageName)}, 'E2E collaborators package', '[]', ${sqlString(packageName)},
	${sqlString(`src-collab-${runId}`)}, 0, 0, 1
);
`)

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${orgSlug}/${packageName}`)
	await waitForClientHydration(page)
	const tab = page.getByTestId('package-repo-nav-collaborators')
	await expect(tab).toBeVisible()
	await Promise.all([
		page.waitForURL(new RegExp(`/@${orgSlug}/${packageName}/collaborators$`)),
		tab.click(),
	])
	await expect(page.getByTestId('package-collaborators-empty')).toBeVisible()

	const status = page.getByRole('status').filter({ hasText: /\S/ }).last()
	const rows = page.getByTestId('package-collaborator')

	const addMember = page.getByTestId('package-collaborators-add-member')
	await addMember
		.getByRole('combobox', { name: 'Member', exact: true })
		.selectOption({ label: `@${member.username}` })
	await addMember.getByRole('button', { name: 'Add member' }).click()
	const memberRow = rows.filter({ hasText: `@${member.username}` })
	await expect(memberRow).toContainText('Org member')
	const memberAccess = memberRow.getByRole('combobox', {
		name: `Access for @${member.username}`,
	})
	await expect(memberAccess).toHaveValue('use')

	await memberAccess.selectOption('manage')
	await expect(status).toContainText(
		`@${member.username} can now manage this package.`,
	)
	await page.reload()
	await waitForClientHydration(page)
	await expect(memberAccess).toHaveValue('manage')

	const addTeam = page.getByTestId('package-collaborators-add-team')
	await addTeam
		.getByRole('combobox', { name: 'Team', exact: true })
		.selectOption({ label: 'Writers (0 members)' })
	await addTeam
		.getByRole('combobox', { name: 'Access for the team' })
		.selectOption('contribute')
	await addTeam.getByRole('button', { name: 'Add team' }).click()
	const teamRow = rows.filter({ hasText: 'Writers' })
	await expect(teamRow).toContainText('Team')
	await expect(
		teamRow.getByRole('combobox', { name: 'Access for Writers' }),
	).toHaveValue('contribute')

	await expect(page.getByTestId('package-collaborators-invite')).toHaveCount(0)

	await memberRow.getByRole('button', { name: 'Remove' }).click()
	await memberRow.getByRole('button', { name: 'Confirm remove' }).click()
	await expect(memberRow).toHaveCount(0)
	await expect(rows).toHaveCount(1)
	await expect(
		addMember.getByRole('combobox', { name: 'Member', exact: true }),
	).toContainText(`@${member.username}`)
})
