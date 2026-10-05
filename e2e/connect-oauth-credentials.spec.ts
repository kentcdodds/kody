import { expect, test, waitForClientHydration } from './playwright-utils.ts'

/**
 * KODY-8K: many same-turn `input` events on controlled credential fields each
 * called `handle.update()`, and Remix's cascade guard threw after 51 updates
 * (`ConnectOauthRoute x51`, minified as `hr` in production). Credential drafts
 * do not need a re-render per keystroke; this pins that rapid sequential insert
 * (autofill / paste / delay-0 typing) stays under the guard.
 */
test('connect oauth credential typing does not trip the update cascade guard', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 60_000 : 45_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `connect-oauth-${runId}@example.com`,
		username: `connect-oauth-${runId}`,
		password: 'connect-oauth-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const cascadeLogs: Array<string> = []
	page.on('console', (msg) => {
		const text = msg.text()
		if (/infinite loop|cascading component updates/i.test(text)) {
			cascadeLogs.push(text)
		}
	})
	page.on('pageerror', (error) => {
		const text = String(error)
		if (/infinite loop|cascading component updates/i.test(text)) {
			cascadeLogs.push(text)
		}
	})

	const setupUrl =
		'/connect/oauth?provider=notion-test&authorizeUrl=' +
		encodeURIComponent('https://api.notion.com/v1/oauth/authorize') +
		'&tokenUrl=' +
		encodeURIComponent('https://api.notion.com/v1/oauth/token') +
		'&flow=confidential&scopes=&allowedHosts=api.notion.com'

	await page.goto(setupUrl)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Enter your app credentials' }),
	).toBeVisible()

	const clientId = page.locator('input[name="oauthClientId"]')
	await clientId.click()
	// delay: 0 packs many input events into one event-loop turn — the same
	// class of burst as password-manager autofill that tripped KODY-8K.
	await clientId.pressSequentially('a'.repeat(60), { delay: 0 })
	await expect(clientId).toHaveValue('a'.repeat(60))

	const clientSecret = page.locator('input[name="oauthClientSecret"]')
	await clientSecret.click()
	await clientSecret.pressSequentially('secret-value-here-12345', {
		delay: 0,
	})
	await expect(clientSecret).toHaveValue('secret-value-here-12345')

	expect(cascadeLogs, cascadeLogs.join('\n')).toEqual([])
})
