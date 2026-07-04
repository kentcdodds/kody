import { expect, test } from '@playwright/test'

test('frame spike SSR inlines frame content and reload updates without navigation', async ({
	page,
	request,
}) => {
	const pageResponse = await request.get('/frame-spike')
	expect(pageResponse.ok()).toBe(true)
	const pageHtml = await pageResponse.text()
	expect(pageHtml).toContain('data-testid="frame-spike-data"')
	expect(pageHtml).toContain('Counter: 0')
	expect(pageHtml).not.toContain('Loading')

	const frameResponse = await request.get('/frame-spike', {
		headers: { 'x-remix-target': 'spike-data' },
	})
	expect(frameResponse.ok()).toBe(true)
	const frameHtml = await frameResponse.text()
	expect(frameHtml).toContain('data-testid="frame-spike-counter"')
	expect(frameHtml).toContain('Counter: 0')
	expect(frameHtml).not.toContain('<html')

	await page.goto('/frame-spike')
	await expect(page.getByTestId('frame-spike-counter')).toHaveText('Counter: 0')

	const initialTimestamp = await page
		.getByTestId('frame-spike-timestamp')
		.textContent()

	expect(
		await page.evaluate(
			() =>
				(window as Window & { __frameSpikeMarker?: boolean })
					.__frameSpikeMarker,
		),
	).toBe(true)

	await page.getByTestId('frame-spike-increment').click()
	await expect(page.getByTestId('frame-spike-counter')).toHaveText('Counter: 1')
	await expect(page.getByTestId('frame-spike-timestamp')).not.toHaveText(
		initialTimestamp ?? '',
	)

	expect(
		await page.evaluate(
			() =>
				(window as Window & { __frameSpikeMarker?: boolean })
					.__frameSpikeMarker,
		),
	).toBe(true)
})
