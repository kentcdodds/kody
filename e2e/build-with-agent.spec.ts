import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('public agent handoff copies a complete prompt and keeps business attribution', async ({
	page,
	context,
}) => {
	await context.clearCookies()
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	for (const path of ['/', '/for/business']) {
		await page.goto(path)
		await waitForClientHydration(page)
		const isHome = path === '/'
		// The homepage repeats its one CTA in the closing section.
		const button = page
			.getByRole('button', {
				name: `${isHome ? 'Connect your agent' : 'Build with your agent'}, copy setup prompt`,
			})
			.first()
		await button.click()
		await expect(button.getByRole('status')).toHaveText(
			'Copied! Paste into your agent',
		)
		const prompt = await page.evaluate(() => navigator.clipboard.readText())
		expect(prompt).toContain('https://kody.codes/auth.md')
		expect(prompt).toContain('search({ entity: "guide:onboarding" })')
		expect(prompt.includes('business=true')).toBe(path === '/for/business')
		// Onboarding happens with the agent, so the homepage prompt skips it.
		expect(prompt.includes('/onboarding')).toBe(!isHome)
		await expect(page).toHaveURL(
			new RegExp(`${isHome ? '/' : '/for/business'}$`),
		)
	}
})
