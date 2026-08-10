import { expect, test } from './playwright-utils.ts'

test('onboarding step 2 hands the whole first win to the agent in one paste', async ({
	login,
	seedE2eUser,
	page,
}) => {
	const user = await seedE2eUser()
	await login({ email: user.email, password: user.password, mode: 'login' })

	await page.goto('/onboarding')
	// Step 1 stays active until an MCP host authorizes, so walk to step 2 the
	// way a person does.
	await expect(page.getByTestId('onboarding-connect-agent')).toBeVisible()
	await page
		.getByRole('navigation', { name: 'Onboarding steps' })
		.getByRole('button', { name: /See it work/ })
		.click()

	const firstWin = page.getByTestId('onboarding-first-win')
	await expect(firstWin).toBeVisible()

	// One paste for the whole loop, and it routes the agent through the guide
	// instead of restating the steps.
	const prompt = firstWin.getByTestId('onboarding-first-win-prompt')
	await expect(prompt).toContainText('/guides/first-win')
	await expect(prompt).toContainText('Ask the connected Kody server')
	await expect(prompt).toContainText('Do not poll')
	await expect(
		firstWin.getByRole('button', { name: 'Copy the prompt' }),
	).toBeVisible()
	// The replaced two-paste flow left no second prompt behind.
	await expect(
		firstWin.getByRole('button', { name: /Copy (send|remember) prompt/ }),
	).toHaveCount(0)

	// The pills are passive progress markers, and Reply keeps the
	// personal-inbox instructions plus the stored-copy fallback.
	const subSteps = firstWin.getByRole('list', {
		name: 'See it work sub-steps',
	})
	await subSteps.getByRole('button', { name: 'Reply', exact: true }).click()
	await expect(
		firstWin.getByText('the address on your Kody account'),
	).toBeVisible()
	await expect(
		firstWin.getByRole('link', { name: 'open your Kody inbox' }),
	).toBeVisible()

	// Remember asks for a message in the chat, not another paste.
	await subSteps.getByRole('button', { name: 'Remember', exact: true }).click()
	await expect(firstWin.getByText('Tell your agent you replied')).toBeVisible()
	await expect(firstWin.locator('blockquote')).toHaveCount(0)

	// The guide the prompt points at is served by this deployment, on the web
	// and as the raw markdown agents fetch.
	await page.goto('/guides/first-win')
	await expect(
		page.getByRole('heading', { level: 1, name: /First win/ }),
	).toBeVisible()
	const rawResponse = await page.request.get('/guides/first-win.md')
	expect(rawResponse.ok()).toBe(true)
	const raw = await rawResponse.text()
	expect(raw).toContain('Welcome to Kody — reply to introduce yourself')
	expect(raw).toContain('meta_memory_upsert')
})
