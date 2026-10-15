import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('homepage agent marquee links each agent to its /with page', async ({
	page,
	context,
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.getByRole('navigation', {
		name: 'Agents that work with Kody',
	})
	// The loop copies are aria-hidden, so only one link per agent is exposed.
	await expect(marquee.getByRole('link')).toHaveCount(22)
	// Hovering pauses the drift so the mark holds still for the click.
	await marquee.hover()
	await marquee.getByRole('link', { name: 'Cursor', exact: true }).click()
	await expect(page).toHaveURL(/\/with\/cursor$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Kody for Cursor' }),
	).toBeVisible()

	await page.goto('/with/claude-code')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Copy step 1' }).click()
	const command = await page.evaluate(() => navigator.clipboard.readText())
	expect(command).toMatch(/^claude mcp add --transport http -s user kody /)

	await page.goto('/with/amp')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: /Copy setup prompt/ }).click()
	const prompt = await page.evaluate(() => navigator.clipboard.readText())
	expect(prompt).toContain('https://kody.codes/docs/connect-your-agent')
	await page.getByRole('button', { name: 'Copy step 2' }).click()
	const mcpUrl = await page.evaluate(() => navigator.clipboard.readText())
	expect(mcpUrl).toMatch(/\/mcp$/)
})

test('agent marquee is one tab stop with arrow keys between agents', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.getByRole('navigation', {
		name: 'Agents that work with Kody',
	})
	const links = marquee.getByRole('link')
	const real = marquee.locator('li:not([aria-hidden]) > a')
	await expect(real.and(page.locator('[tabindex="0"]'))).toHaveCount(1)
	await expect(real.and(page.locator('[tabindex="-1"]'))).toHaveCount(21)

	await page
		.getByRole('heading', { level: 1 })
		.first()
		.evaluate((heading) => {
			heading.setAttribute('tabindex', '-1')
			;(heading as HTMLElement).focus()
		})
	await page.keyboard.press('Tab')
	const first = await page.evaluate(() => document.activeElement?.textContent)
	expect(first).toBeTruthy()
	await expect(marquee.locator(':focus')).toBeVisible()

	await page.keyboard.press('ArrowRight')
	const second = await page.evaluate(() => document.activeElement?.textContent)
	expect(second).not.toBe(first)
	await expect(marquee.locator(':focus')).toBeInViewport()
	await page.keyboard.press('ArrowLeft')
	expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
		first,
	)

	// End then ArrowRight wraps around to the first agent.
	await page.keyboard.press('End')
	await page.keyboard.press('ArrowRight')
	const names = await links.allTextContents()
	expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
		names[0],
	)
	await expect(marquee.locator(':focus')).toBeInViewport()

	// One Tab leaves the whole row.
	await page.keyboard.press('Tab')
	expect(
		await marquee.evaluate((nav) => nav.contains(document.activeElement)),
	).toBe(false)
	await expect(
		page.getByRole('button', { name: /Connect your agent/ }).first(),
	).toBeFocused()
})

test('agent marquee drift resumes after a press released outside the row', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' })
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.locator('nav.landing-agents')
	await expect(marquee).toHaveClass(/is-looping/)
	const box = await marquee.boundingBox()
	if (!box) throw new Error('marquee has no box')
	await page.mouse.move(box.x + box.width / 2, box.y + 40)
	await page.mouse.down()
	await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height + 200)
	await page.mouse.up()
	await page.waitForTimeout(3_000)
	const before = await marquee.evaluate((nav) => nav.scrollLeft)
	await expect
		.poll(() => marquee.evaluate((nav) => nav.scrollLeft), { timeout: 5_000 })
		.not.toBe(before)
})

test('agent marquee magnifies by pointer distance, gaps included', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.locator('nav.landing-agents')
	await expect(marquee).toHaveClass(/is-looping/)
	const box = await marquee.boundingBox()
	if (!box) throw new Error('marquee has no box')
	await page.mouse.move(box.x + box.width / 2, box.y + 40)
	const [left, right] = await marquee.evaluate((nav) => {
		const navLeft = nav.getBoundingClientRect().left
		const visible = [...nav.querySelectorAll('.landing-agent-icon')]
			.map((icon) => {
				const rect = icon.getBoundingClientRect()
				return (rect.left + rect.right) / 2 - navLeft
			})
			.filter((x) => x > 150 && x < nav.clientWidth - 150)
		return [visible[1] ?? 0, visible[2] ?? 0]
	})
	await page.mouse.move(box.x + (left + right) / 2, box.y + 40)
	const scales = () =>
		marquee.evaluate((nav) =>
			[...nav.querySelectorAll('.landing-agent-icon')]
				.map((icon) => Number(getComputedStyle(icon).scale) || 1)
				.sort((a, b) => b - a)
				.slice(0, 2),
		)
	await expect
		.poll(async () => Math.min(...(await scales())))
		.toBeGreaterThan(1.15)

	await page.mouse.move(box.x + box.width / 2, box.y + box.height + 300)
	await expect.poll(async () => Math.max(...(await scales()))).toBe(1)
})

test('agent marquee scrolls endlessly in both directions', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.locator('nav.landing-agents')
	await expect(marquee).toHaveClass(/is-looping/)
	const readScroll = () =>
		marquee.evaluate((nav) => ({
			left: nav.scrollLeft,
			max: nav.scrollWidth - nav.clientWidth,
		}))
	const start = await readScroll()
	expect(start.left).toBeGreaterThan(0)

	for (const direction of [1, -1]) {
		for (let step = 0; step < 40; step++) {
			await marquee.evaluate((nav, d) => nav.scrollBy(d * 300, 0), direction)
		}
		const after = await readScroll()
		// The view wraps by one list width, so it never reaches either end.
		expect(after.left).toBeGreaterThan(0)
		expect(after.left).toBeLessThan(after.max)
	}
})
