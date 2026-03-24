import { expect, test } from '@playwright/test'

const inlineCode = [
	'<main>',
	'  <h1>Inline app</h1>',
	'  <button type="button" data-send-message>Send message</button>',
	'  <button type="button" data-open-link>Open docs</button>',
	'  <button type="button" data-fullscreen>Fullscreen</button>',
	'</main>',
	'<script>',
	'  const sendButton = document.querySelector("[data-send-message]");',
	'  const linkButton = document.querySelector("[data-open-link]");',
	'  const fullscreenButton = document.querySelector("[data-fullscreen]");',
	'  sendButton?.addEventListener("click", () => {',
	'    window.kodyWidget.sendMessage("Inline widget says hello");',
	'  });',
	'  linkButton?.addEventListener("click", () => {',
	'    window.kodyWidget.openLink("https://example.com/docs");',
	'  });',
	'  fullscreenButton?.addEventListener("click", async () => {',
	'    const nextMode = await window.kodyWidget.toggleFullscreen();',
	'    const status = document.createElement("p");',
	'    status.textContent = `Mode: ${nextMode}`;',
	'    document.body.append(status);',
	'  });',
	'</script>',
].join('\n')

test('generated ui shell renders inline code in default iframe', async ({
	page,
}) => {
	await page.goto('/dev/generated-ui-shell-test.html')
	await expect(
		page.getByRole('heading', { name: 'Generated UI Shell Test' }),
	).toBeVisible()

	const shellFrame = page.frameLocator('#generated-default')
	const appFrame = shellFrame.locator('[data-generated-ui-frame]')
	await expect(appFrame).toBeVisible()
	await expect(
		appFrame.contentFrame().getByRole('heading', { name: 'Inline app' }),
	).toBeVisible()
})

test('generated ui shell renders inline code in sandboxed iframe', async ({
	page,
}) => {
	await page.goto(
		`/dev/generated-ui-shell-test.html?code=${encodeURIComponent(inlineCode)}`,
	)
	const shellFrame = page.frameLocator('#generated-sandboxed')
	const sandboxedIframe = shellFrame.locator('[data-generated-ui-frame]')
	await expect(sandboxedIframe).toBeVisible()
	await expect(
		sandboxedIframe.contentFrame().getByRole('heading', { name: 'Inline app' }),
	).toBeVisible()
})

test('sandboxed generated ui shell supports host messaging actions', async ({
	page,
}) => {
	await page.goto(
		`/dev/generated-ui-shell-test.html?code=${encodeURIComponent(inlineCode)}`,
	)
	const shellFrame = page.frameLocator('#generated-sandboxed')
	const sandboxedIframe = shellFrame.locator('[data-generated-ui-frame]')
	await expect(sandboxedIframe).toBeVisible()
	await expect(
		sandboxedIframe.contentFrame().getByRole('heading', { name: 'Inline app' }),
	).toBeVisible()

	await sandboxedIframe
		.contentFrame()
		.getByRole('button', { name: 'Send message' })
		.click()
	await expect(
		page.locator('[data-host-chat="generated-sandboxed"] [data-chat-message]'),
	).toContainText('Inline widget says hello')

	await sandboxedIframe
		.contentFrame()
		.getByRole('button', { name: 'Open docs' })
		.click()
	await expect(
		page.locator('[data-host-links="generated-sandboxed"] [data-open-link]'),
	).toContainText('https://example.com/docs')

	await sandboxedIframe
		.contentFrame()
		.getByRole('button', { name: 'Fullscreen' })
		.click()
	await expect(
		sandboxedIframe.contentFrame().getByText('Mode: fullscreen'),
	).toBeVisible()
})
