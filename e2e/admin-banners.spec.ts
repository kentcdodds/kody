import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from './playwright-utils.ts'

const screenshotDir =
	process.env.SITE_BANNER_SCREENSHOT_DIR ??
	(existsSync('/opt/cursor/artifacts') ? '/opt/cursor/artifacts' : null)

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
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin banners' }),
	).toBeVisible()
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
		await page.goto(`/?siteBannerLook=${look}`)
		await expect(page.getByTestId('site-banner')).toBeVisible()
		await expect(page.getByTestId('site-banner')).toHaveAttribute(
			'data-look',
			look,
		)
		await captureIfRequested(page, `option_${look}_desktop.png`)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(page.getByTestId('site-banner')).toBeVisible()
		await captureIfRequested(page, `option_${look}_mobile.png`)
	}

	const title = `Launch video ${runId}`
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto('/admin/banners')
	await waitForClientHydration(page)
	await expect(page.getByRole('heading', { name: 'New banner' })).toBeVisible()
	await page.getByLabel('Title', { exact: true }).fill(title)
	await page.getByLabel('Body').fill('Watch the launch video.')
	await page.getByLabel('CTA URL').fill('https://example.com/kody-launch-video')
	await page.getByLabel('CTA label').fill('Watch the video')
	await page.getByRole('checkbox', { name: 'Enabled' }).check()
	await page.getByRole('button', { name: 'Save banner' }).click()
	await expect(page.getByText('Banner created.')).toBeVisible()
	await expect(
		page.getByRole('button', { name: new RegExp(title) }),
	).toBeVisible()
})
