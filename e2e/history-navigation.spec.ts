import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from './playwright-utils.ts'

type HistoryFrame = {
	path: string
	scrollY: number
	featureOnScreen: boolean
	featureStylesheetApplied: boolean
	homeOnScreen: boolean
}

type HistoryRecording = {
	frames: Array<HistoryFrame>
	viewTransitions: number
}

/**
 * Sample every animation frame from now until `stopHistoryRecording`. Back /
 * Forward must paint the destination styled and already at its restored
 * scroll position: no frame of feature content without its stylesheet, no
 * frame of the homepage away from its saved scroll, no view transition.
 */
async function startHistoryRecording(page: Page) {
	await page.evaluate(() => {
		const recording: HistoryRecording = { frames: [], viewTransitions: 0 }
		const start = document.startViewTransition?.bind(document)
		if (start) {
			document.startViewTransition = ((update) => {
				recording.viewTransitions += 1
				return start(update)
			}) as typeof document.startViewTransition
		}
		let recordingActive = true
		const sample = () => {
			if (!recordingActive) return
			const stylesheet = document.querySelector<HTMLLinkElement>(
				'link[rel="stylesheet"][href="/feature-pages.css"]',
			)
			recording.frames.push({
				path: location.pathname,
				scrollY: Math.round(window.scrollY),
				featureOnScreen: Boolean(document.querySelector('.feature-detail')),
				featureStylesheetApplied: Boolean(stylesheet?.sheet),
				homeOnScreen: Boolean(
					document.querySelector('main a[href="/features/memory"]'),
				),
			})
			requestAnimationFrame(sample)
		}
		requestAnimationFrame(sample)
		Object.assign(window, {
			__kodyStopHistoryRecording: () => {
				recordingActive = false
				return recording
			},
		})
	})
}

function stopHistoryRecording(page: Page) {
	return page.evaluate(() =>
		(
			window as unknown as {
				__kodyStopHistoryRecording: () => HistoryRecording
			}
		).__kodyStopHistoryRecording(),
	)
}

function expectFeatureStylesheetApplied(page: Page) {
	return expect
		.poll(() =>
			page.evaluate(() =>
				Boolean(
					document.querySelector<HTMLLinkElement>(
						'link[rel="stylesheet"][href="/feature-pages.css"]',
					)?.sheet,
				),
			),
		)
		.toBe(true)
}

function unstyledFeatureFrames(recording: HistoryRecording) {
	return recording.frames.filter(
		(frame) => frame.featureOnScreen && !frame.featureStylesheetApplied,
	)
}

// Warm the feature route chunk first: a cold Vite compile can outlast the
// router's navigation timeout and turn the click into a document load.
async function openWarmHomepage(
	page: Page,
	warmPaths: Array<string> = ['/features/memory'],
) {
	await page.context().clearCookies()
	for (const path of warmPaths) {
		await page.goto(path)
		await waitForClientHydration(page)
	}
	await page.goto('/')
	await waitForClientHydration(page)
	await page.evaluate(() => Object.assign(window, { __kodyBootDocument: true }))
}

test('a lantern link and Back/Forward paint styled and at the restored scroll', async ({
	page,
}) => {
	await openWarmHomepage(page)
	// A slow route stylesheet must hold the swap, not paint the page bare.
	await page.route('**/feature-pages.css', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 400))
		await route.continue()
	})

	const lanternLink = page
		.getByRole('main')
		.getByRole('link', { name: 'memory', exact: true })
	await lanternLink.scrollIntoViewIfNeeded()
	await expect
		.poll(() => page.evaluate(() => Math.round(window.scrollY)))
		.toBeGreaterThan(0)
	const homeScrollY = await page.evaluate(() => Math.round(window.scrollY))

	await startHistoryRecording(page)
	await lanternLink.click()
	await expect(page).toHaveURL(/\/features\/memory$/)
	await expect(page.locator('.feature-detail')).toBeVisible()
	await expectFeatureStylesheetApplied(page)
	const click = await stopHistoryRecording(page)
	expect(
		await page.evaluate(() => '__kodyBootDocument' in window),
		'the lantern click stayed in the SPA',
	).toBe(true)
	expect(unstyledFeatureFrames(click), 'click painted unstyled').toEqual([])

	const documentRefetches: Array<string> = []
	page.on('request', (request) => {
		const url = new URL(request.url())
		if (
			url.pathname === '/' &&
			(request.headers().accept ?? '').includes('text/html')
		) {
			documentRefetches.push(`${request.method()} ${request.url()}`)
		}
	})

	await startHistoryRecording(page)
	await page.goBack()
	await expect(page).toHaveURL(/\/$/)
	await expect(lanternLink).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => Math.round(window.scrollY)))
		.toBe(homeScrollY)
	const back = await stopHistoryRecording(page)
	expect(documentRefetches, 'Back refetched the whole document').toEqual([])
	expect(unstyledFeatureFrames(back), 'Back painted unstyled').toEqual([])
	expect(
		back.frames.filter(
			(frame) => frame.homeOnScreen && frame.scrollY !== homeScrollY,
		),
		'homepage painted away from its restored scroll position',
	).toEqual([])
	expect(back.viewTransitions).toBe(0)

	await startHistoryRecording(page)
	await page.goForward()
	await expect(page).toHaveURL(/\/features\/memory$/)
	await expect(page.locator('.feature-detail')).toBeVisible()
	await expectFeatureStylesheetApplied(page)
	const forward = await stopHistoryRecording(page)
	expect(unstyledFeatureFrames(forward), 'Forward painted unstyled').toEqual([])
	expect(
		forward.frames.filter(
			(frame) => frame.featureOnScreen && frame.scrollY !== 0,
		),
		'feature page painted away from the top',
	).toEqual([])
	expect(forward.viewTransitions).toBe(0)
})

test('a superseding feature navigation waits for the stylesheet already loading', async ({
	page,
}) => {
	await openWarmHomepage(page, ['/features/memory', '/features/secrets'])
	await page.route('**/feature-pages.css', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2_500))
		await route.continue()
	})
	const lantern = page.getByRole('main')
	await lantern
		.getByRole('link', { name: 'memory', exact: true })
		.scrollIntoViewIfNeeded()

	await startHistoryRecording(page)
	await lantern.getByRole('link', { name: 'memory', exact: true }).click()
	// The first navigation is now waiting on the stylesheet it inserted.
	await expect(
		page.locator('link[rel="stylesheet"][href="/feature-pages.css"]'),
	).toBeAttached()
	await lantern.getByRole('link', { name: 'secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/features\/secrets$/)
	await expect(page.locator('.feature-detail')).toBeVisible()
	await expectFeatureStylesheetApplied(page)
	const recording = await stopHistoryRecording(page)

	expect(await page.evaluate(() => '__kodyBootDocument' in window)).toBe(true)
	expect(unstyledFeatureFrames(recording), 'painted unstyled').toEqual([])
})

test('a route stylesheet that fails to load falls back to a document load', async ({
	page,
}) => {
	await openWarmHomepage(page)
	let stylesheetRequests = 0
	await page.route('**/feature-pages.css', async (route) => {
		stylesheetRequests += 1
		if (stylesheetRequests === 1) {
			await route.abort('failed')
			return
		}
		await route.continue()
	})

	await page
		.getByRole('main')
		.getByRole('link', { name: 'memory', exact: true })
		.click()
	await expect(page).toHaveURL(/\/features\/memory$/)
	await expect
		.poll(() => page.evaluate(() => '__kodyBootDocument' in window))
		.toBe(false)
	await expect(page.locator('.feature-detail')).toBeVisible()
	await expectFeatureStylesheetApplied(page)
	expect(stylesheetRequests).toBe(2)
})
