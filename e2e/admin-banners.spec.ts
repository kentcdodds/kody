import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './playwright-utils.ts'

const screenshotDir = process.env.SITE_BANNER_SCREENSHOT_DIR ?? null

function screenshotPath(name: string): string {
	if (!screenshotDir) {
		throw new Error('screenshotDir is unset')
	}
	mkdirSync(screenshotDir, { recursive: true })
	return join(screenshotDir, name)
}

async function captureIfRequested(page: Page, name: string) {
	if (!screenshotDir) return
	// Crop the classic Linux scrollbar track so the artifact matches overlay
	// scrollbars (the banner already spans `document.body.clientWidth`).
	const clip = await page.evaluate(() => ({
		x: 0,
		y: 0,
		width: document.body.clientWidth,
		height: window.innerHeight,
	}))
	await page.screenshot({ path: screenshotPath(name), clip })
}

async function expectBannerSpansViewport(page: Page, look: string) {
	const banner = page.getByTestId('site-banner')
	await expect(banner).toBeVisible()
	const box = await banner.boundingBox()
	const bodyWidth = await page.evaluate(() => document.body.clientWidth)
	expect(box, `${look} banner box`).toBeTruthy()
	expect(box?.x, `${look} banner left edge`).toBe(0)
	expect(box?.width, `${look} banner width`).toBe(bodyWidth)
}

async function disableLeftoverEnabledBanners(page: Page) {
	const listed = await page.request.get('/admin/banners.json')
	expect(listed.ok()).toBeTruthy()
	const payload = (await listed.json()) as {
		banners?: Array<{ id: string; enabled: boolean }>
	}
	for (const banner of payload.banners ?? []) {
		if (!banner.enabled) continue
		const deleted = await page.request.post('/admin/banners.json', {
			data: { action: 'delete', id: banner.id },
		})
		expect(deleted.ok(), `delete leftover ${banner.id}`).toBeTruthy()
	}
}

test('admin can create a site banner and preview launch looks', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `banner-admin-${runId}@example.com`,
		username: `banner-admin-${runId}`,
		password: 'banner-admin-password',
		admin: true,
	})
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})

	await page.goto('/admin/banners')
	await expect(
		page.getByRole('heading', { name: 'Admin banners' }),
	).toBeVisible({ timeout: 20_000 })
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true', {
		timeout: 15_000,
	})
	await expect(page.getByRole('heading', { name: 'Look spike' })).toBeVisible()
	await expect(page.getByTestId('site-banner-preview-strip')).toBeVisible()
	await expect(page.getByTestId('site-banner-preview-promo')).toBeVisible()
	await expect(page.getByTestId('site-banner-preview-card')).toBeVisible()
	await disableLeftoverEnabledBanners(page)

	if (screenshotDir) {
		await page.setViewportSize({ width: 1280, height: 900 })
		await page.screenshot({
			path: screenshotPath('admin_banners_desktop.png'),
			fullPage: true,
		})
	}

	const looks = ['strip', 'promo', 'card'] as const
	for (const look of looks) {
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.emulateMedia({ colorScheme: 'light' })
		await page.goto(`/?siteBannerLook=${look}`)
		const banner = page.getByTestId('site-banner')
		await expect(banner).toBeVisible()
		await expect(banner).toHaveAttribute('data-look', look)
		await expect(banner.getByText('Kody is live')).toBeVisible()
		await expectBannerSpansViewport(page, `${look} desktop`)
		await captureIfRequested(page, `option_${look}_desktop.png`)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(banner).toBeVisible()
		await expectBannerSpansViewport(page, `${look} mobile`)
		await captureIfRequested(page, `option_${look}_mobile.png`)
	}

	await page.emulateMedia({ colorScheme: 'dark' })
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto('/?siteBannerLook=promo')
	const darkPromo = page.getByTestId('site-banner')
	await expect(darkPromo).toBeVisible()
	await expect(darkPromo).toHaveAttribute('data-look', 'promo')
	await expect(darkPromo.getByText('Kody is live')).toBeVisible()
	await expectBannerSpansViewport(page, 'promo dark desktop')
	await captureIfRequested(page, 'option_b_promo_strip_dark_desktop.png')

	await page.setViewportSize({ width: 390, height: 844 })
	await expect(darkPromo).toBeVisible()
	await expectBannerSpansViewport(page, 'promo dark mobile')
	await captureIfRequested(page, 'option_b_promo_strip_dark_mobile.png')
	await page.emulateMedia({ colorScheme: 'light' })

	const title = `Launch video ${runId}`
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto('/admin/banners')
	await expect(page.getByRole('heading', { name: 'New banner' })).toBeVisible({
		timeout: 20_000,
	})
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true', {
		timeout: 15_000,
	})
	await page.getByLabel('Title', { exact: true }).fill(title)
	await page.getByLabel('Body').fill('Watch the launch video.')
	await page.getByLabel('CTA URL').fill('https://example.com/kody-launch-video')
	await page.getByLabel('CTA label').fill('Watch the video')
	await page.getByRole('button', { name: 'Save banner' }).click()
	await expect(page.getByText('Banner created.')).toBeVisible()
	await expect(
		page.getByRole('button', { name: new RegExp(title) }),
	).toBeVisible()
})
