import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

type MainSnapshot = {
	h1: string
	status: string
}

/**
 * Record every distinct state `<main>` passes through from now until read.
 * Navigation must swap the previous article for the next one in a single
 * commit: no intermediate state without an `<h1>` and no `role="status"`
 * loading copy — that is the "flash of loading" this suite guards against.
 */
async function observeMainTransitions(page: Page) {
	await page.evaluate(() => {
		const main = document.getElementById('main')
		if (!main) throw new Error('Expected #main')
		const snapshot = () => ({
			h1: main.querySelector('h1')?.textContent?.trim() ?? '',
			status: Array.from(main.querySelectorAll('[role="status"]'))
				.map((node) => node.textContent?.trim() ?? '')
				.join(' | '),
		})
		const log: Array<MainSnapshot> = [snapshot()]
		const observer = new MutationObserver(() => {
			const next = snapshot()
			const last = log[log.length - 1]
			if (last && last.h1 === next.h1 && last.status === next.status) return
			log.push(next)
		})
		observer.observe(main, {
			childList: true,
			subtree: true,
			characterData: true,
		})
		Object.assign(window, { __kodyMainTransitions: log })
	})
}

async function readMainTransitions(page: Page) {
	return page.evaluate(
		() =>
			(window as unknown as { __kodyMainTransitions: Array<MainSnapshot> })
				.__kodyMainTransitions,
	)
}

test('docs guide switches keep the current article on screen until the next one is ready (no loading flash)', async ({
	page,
}) => {
	await page.context().clearCookies()
	await page.goto('/docs/memory')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Shared memory' }),
	).toBeVisible()

	const docRequests: Array<string> = []
	page.on('request', (request) => {
		if (request.url().includes('/docs/') && request.url().endsWith('.json')) {
			docRequests.push(new URL(request.url()).pathname)
		}
	})

	await observeMainTransitions(page)
	const sidebar = page.getByRole('navigation', { name: 'Docs' }).first()
	await sidebar.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()

	const transitions = await readMainTransitions(page)
	expect(transitions[0]?.h1).toBe('Shared memory')
	expect(transitions.at(-1)?.h1).toBe('Secrets')
	for (const state of transitions) {
		// Every intermediate DOM state still shows an article title.
		expect(state.h1, JSON.stringify(transitions)).not.toBe('')
		// ...and never a loading message in place of one.
		expect(state.status, JSON.stringify(transitions)).not.toMatch(/loading/i)
	}
	// The router preloads the destination once; the route must not refetch
	// the payload it was just handed (that refetch was the loading flash).
	expect(docRequests).toEqual(['/docs/secrets.json'])
})

test('docs site: header says Docs, /docs opens the introduction with a sidebar, and legacy /guides redirects', async ({
	page,
	request,
}) => {
	await page.context().clearCookies()

	await page.goto('/')
	const headerDocs = page
		.getByRole('navigation', { name: 'Main' })
		.getByRole('link', { name: 'Docs', exact: true })
	await expect(headerDocs).toBeVisible()
	await headerDocs.click()
	await expect(page).toHaveURL(/\/docs$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'What is Kody?' }),
	).toBeVisible()

	// The sidebar carries the whole reading order and marks the current page.
	const sidebar = page.getByRole('navigation', { name: 'Docs' }).first()
	await expect(sidebar).toBeVisible()
	await expect(
		sidebar.getByRole('link', { name: 'What is Kody?', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(
		sidebar.getByRole('link', { name: 'Shared memory', exact: true }),
	).toBeVisible()

	// In-app navigation to another doc keeps the shell and updates the head.
	await sidebar.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()
	await expect(page).toHaveTitle(/Secrets — Kody Docs/)
	await expect(
		sidebar.getByRole('link', { name: 'Secrets', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	// Previous / next follow the docs order.
	const pager = page.getByRole('navigation', { name: 'Docs order' })
	await expect(pager.getByRole('link', { name: /Previous/ })).toHaveAttribute(
		'href',
		/\/docs\//,
	)
	await expect(pager.getByRole('link', { name: /Next/ })).toHaveAttribute(
		'href',
		/\/docs\//,
	)

	// Provider index sits inside the same shell.
	await sidebar
		.getByRole('link', { name: 'Connect a provider', exact: true })
		.click()
	await expect(page).toHaveURL(/\/docs\/connect$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Connect a provider' }),
	).toBeVisible()
	await expect(page.getByRole('link', { name: /Connect GitHub/ })).toBeVisible()

	// Old bookmarks keep resolving.
	const legacy = await request.get('/guides/oauth', { maxRedirects: 0 })
	expect(legacy.status()).toBe(308)
	expect(legacy.headers()['location']).toBe('/docs/oauth')
	const legacyMarkdown = await request.get('/guides/what-is-kody.md', {
		maxRedirects: 0,
	})
	expect(legacyMarkdown.status()).toBe(308)
	expect(legacyMarkdown.headers()['location']).toBe('/docs/what-is-kody.md')
	const merged = await request.get(
		'/guides/integration-backed-app-happy-path',
		{ maxRedirects: 0 },
	)
	expect(merged.status()).toBe(308)
	expect(merged.headers()['location']).toBe(
		'/docs/package-apps#after-an-integration-smoke-test',
	)

	// Agent-facing twins.
	const markdown = await request.get('/docs/secrets.md')
	expect(markdown.status()).toBe(200)
	expect(markdown.headers()['content-type']).toContain('text/markdown')
	expect(await markdown.text()).toContain('# Secrets')
	const llms = await request.get('/llms.txt')
	expect(llms.status()).toBe(200)
	expect(await llms.text()).toContain('/docs/secrets.md')
})
