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
	await page.screenshot({ path: screenshotPath(name), fullPage: false })
}

test('admin can create a site banner and preview launch looks', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
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
		const desktopBox = await banner.boundingBox()
		expect(desktopBox, `${look} desktop banner box`).toBeTruthy()
		expect(desktopBox?.x).toBe(0)
		expect(desktopBox?.width).toBe(1280)
		await captureIfRequested(page, `option_${look}_desktop.png`)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(banner).toBeVisible()
		const mobileBox = await banner.boundingBox()
		expect(mobileBox, `${look} mobile banner box`).toBeTruthy()
		expect(mobileBox?.x).toBe(0)
		expect(mobileBox?.width).toBe(390)
		await captureIfRequested(page, `option_${look}_mobile.png`)
	}

	await page.emulateMedia({ colorScheme: 'dark' })
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto('/?siteBannerLook=promo')
	const darkPromo = page.getByTestId('site-banner')
	await expect(darkPromo).toBeVisible()
	await expect(darkPromo).toHaveAttribute('data-look', 'promo')
	const darkDesktopBox = await darkPromo.boundingBox()
	expect(darkDesktopBox?.x).toBe(0)
	expect(darkDesktopBox?.width).toBe(1280)
	await captureIfRequested(page, 'option_b_promo_strip_dark_desktop.png')

	await page.setViewportSize({ width: 390, height: 844 })
	await expect(darkPromo).toBeVisible()
	const darkMobileBox = await darkPromo.boundingBox()
	expect(darkMobileBox?.x).toBe(0)
	expect(darkMobileBox?.width).toBe(390)
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
