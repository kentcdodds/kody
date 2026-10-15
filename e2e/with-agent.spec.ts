import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('homepage agent marquee links each agent to its /with page', async ({
	page,
	context,
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.getByRole('navigation', {
		name: 'Agents that work with Kody',
	})
	// The loop copy is aria-hidden, so only one link per agent is exposed.
	await expect(marquee.getByRole('link')).toHaveCount(22)
	// Hovering pauses the loop so the mark holds still for the click.
	await marquee.hover()
	await marquee.getByRole('link', { name: 'Cursor', exact: true }).click()
	await expect(page).toHaveURL(/\/with\/cursor$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Kody for Cursor' }),
	).toBeVisible()

	await page.goto('/with/claude-code')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Copy step 1' }).click()
	const command = await page.evaluate(() => navigator.clipboard.readText())
	expect(command).toMatch(/^claude mcp add --transport http -s user kody /)

	await page.goto('/with/amp')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: /Copy setup prompt/ }).click()
	const prompt = await page.evaluate(() => navigator.clipboard.readText())
	expect(prompt).toContain('https://kody.codes/docs/connect-your-agent')
	await page.getByRole('button', { name: 'Copy step 2' }).click()
	const mcpUrl = await page.evaluate(() => navigator.clipboard.readText())
	expect(mcpUrl).toMatch(/\/mcp$/)
})
