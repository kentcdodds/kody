import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

async function openSwitcher(page: Page) {
	const trigger = page.getByTestId('org-switcher')
	const panel = page.getByTestId('org-switcher-panel')
	await trigger.click()
	await expect(panel).toBeVisible()
	await expect(trigger).toHaveAttribute('aria-expanded', 'true')
	// Let the entrance transition settle before measuring.
	await expect
		.poll(() => panel.evaluate((node) => getComputedStyle(node).opacity))
		.toBe('1')
	return { trigger, panel }
}

/**
 * The panel hangs from its trigger: just below it, sharing its left edge, or
 * its right edge when a left-aligned panel would run off the viewport.
 */
async function expectPanelAnchoredToTrigger(page: Page) {
	const { trigger, panel } = await openSwitcher(page)
	const triggerBox = await trigger.boundingBox()
	const panelBox = await panel.boundingBox()
	const viewportWidth = page.viewportSize()?.width ?? 0
	if (!triggerBox || !panelBox) throw new Error('Switcher is not laid out.')

	const gap = panelBox.y - (triggerBox.y + triggerBox.height)
	expect(gap).toBeGreaterThanOrEqual(4)
	expect(gap).toBeLessThanOrEqual(12)
	expect(panelBox.x).toBeGreaterThanOrEqual(0)
	expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewportWidth)

	const fitsFromTriggerLeft = triggerBox.x + panelBox.width <= viewportWidth
	if (fitsFromTriggerLeft) {
		expect(Math.abs(panelBox.x - triggerBox.x)).toBeLessThanOrEqual(1)
	} else {
		expect(
			Math.abs(panelBox.x + panelBox.width - (triggerBox.x + triggerBox.width)),
		).toBeLessThanOrEqual(1)
	}
	return { trigger, panel, fitsFromTriggerLeft }
}

test('org switcher opens under its trigger, lists orgs, and closes like a menu', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-switcher-${runId}@example.com`,
		username: `org-switcher-${runId}`,
		password: 'org-switcher-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	// Create a second organization through the form; the handle follows the name.
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Pinned ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(`pinned-${runId}`)
	await page.getByRole('button', { name: 'Create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}$`))
	await expect(
		page.getByRole('heading', { level: 1, name: `Pinned ${runId}` }),
	).toBeVisible()
	await expect(page.getByTestId('org-home')).toBeVisible()
	await waitForClientHydration(page)

	const wide = await expectPanelAnchoredToTrigger(page)
	expect(wide.fitsFromTriggerLeft).toBe(true)
	await expect(
		wide.panel.getByTestId(`org-switcher-pinned-${runId}`),
	).toHaveAttribute('aria-current', 'true')
	await expect(
		wide.panel.getByTestId(`org-switcher-${user.username}`),
	).not.toHaveAttribute('aria-current', 'true')
	await expect(wide.panel.getByTestId('org-switcher-create')).toBeVisible()
	// No invites waiting, so no Invites row; the person's own links follow.
	await expect(wide.panel.getByTestId('org-switcher-invites')).toHaveCount(0)
	const accountGroup = wide.panel.getByRole('group', { name: 'Your account' })
	await expect(
		accountGroup.getByRole('link', { name: 'Your profile' }),
	).toHaveAttribute('href', `/@${user.username}`)
	await expect(
		accountGroup.getByRole('link', { name: 'Account settings' }),
	).toHaveAttribute('href', '/account')
	await expect(
		accountGroup.getByRole('button', { name: 'Log out' }),
	).toBeVisible()

	// Arrow keys walk the rows; Escape closes and returns focus to the trigger.
	await wide.trigger.focus()
	await page.keyboard.press('ArrowDown')
	await expect(
		wide.panel.getByTestId(`org-switcher-${user.username}`),
	).toBeFocused()
	await page.keyboard.press('End')
	await expect(wide.panel.getByTestId('org-switcher-logout')).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(wide.panel).toBeHidden()
	await expect(wide.trigger).toBeFocused()
	await expect(wide.trigger).toHaveAttribute('aria-expanded', 'false')

	// At narrow desktop the switcher (last in the header) sits near the
	// viewport edge, so the panel flips to share the trigger's right edge.
	// A click outside closes it.
	await page.setViewportSize({ width: 860, height: 800 })
	const narrow = await expectPanelAnchoredToTrigger(page)
	expect(narrow.fitsFromTriggerLeft).toBe(false)
	await page.mouse.click(20, 700)
	await expect(narrow.panel).toBeHidden()
})
