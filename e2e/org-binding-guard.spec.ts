import { expect, test, waitForClientHydration } from './playwright-utils.ts'

const orgSectionApis = [
	['memories', 'memories'],
	['memories-export', 'memories'],
	['workflows', 'workflows'],
	['webhooks', 'webhooks'],
	['mcp-servers', 'mcp-servers'],
	['integrations', 'integrations'],
	['secret-providers', 'secret-providers'],
	['values', 'values'],
	['email', 'email'],
	['activity', 'activity'],
	['waiting', 'waiting'],
	['secrets', 'secrets'],
	['jobs', 'jobs'],
	['connected-agents', 'connections'],
] as const

test('an org the person cannot use is a 404 on every section, never their own data', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	const owner = await seedE2eUser({
		email: `org-guard-owner-${runId}@example.com`,
		username: `org-guard-owner-${runId}`,
		password: 'org-guard-owner-password',
	})
	const stranger = await seedE2eUser({
		email: `org-guard-stranger-${runId}@example.com`,
		username: `org-guard-stranger-${runId}`,
		password: 'org-guard-stranger-password',
	})
	const vault = `vault-${runId}`

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Vault ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(vault)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@${vault}$`))
	await page.context().clearCookies()

	await login({
		email: stranger.email,
		password: stranger.password,
		mode: 'login',
	})
	const memory = await page.request.post('/account/memories.json', {
		data: { action: 'noop' },
		headers: {
			'Content-Type': 'application/json',
			Referer: `${origin}/@${vault}/-/memories`,
		},
	})
	expect(memory.status()).toBe(404)

	for (const section of ['memories', 'workflows', 'webhooks', 'mcp-servers']) {
		const response = await page.goto(`/@${vault}/-/${section}`)
		expect(response?.status(), section).toBe(404)
	}

	for (const [api, section] of orgSectionApis) {
		const denied = await page.request.get(`/account/${api}.json`, {
			headers: { Referer: `${origin}/@${vault}/-/${section}` },
		})
		expect(denied.status(), api).toBe(404)
		await expect(denied.json()).resolves.toEqual({
			ok: false,
			error: 'Organization not found.',
		})
	}

	// The stranger's own org still answers from its own pages.
	for (const [api, section] of orgSectionApis) {
		const own = await page.request.get(`/account/${api}.json`, {
			headers: { Referer: `${origin}/@${stranger.username}/-/${section}` },
		})
		expect(own.status(), api).toBe(200)
	}
	const ownPage = await page.goto(`/@${stranger.username}/-/memories`)
	expect(ownPage?.status()).toBe(200)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Memories' }),
	).toBeVisible()
})
