import { expect, test, type Page } from './playwright-utils.ts'

test.describe.configure({ mode: 'serial' })

async function createThread(page: Page, message: string) {
	await page.goto('/chat')
	await page.getByRole('button', { name: 'New thread' }).click()
	await expect(page).toHaveURL(/\/chat\/.+/)
	await page.getByPlaceholder('Send a message…').fill(message)
	await page.getByRole('button', { name: 'Send message' }).click()
	await expect(page).toHaveURL(/\/chat\/.+/)
}

test('redirects to login when unauthenticated', async ({ page }) => {
	await page.goto('/chat')
	await expect(page).toHaveURL(/\/login/)
})

test('loads chat page when authenticated', async ({ page, login }) => {
	await login()
	await page.goto('/chat')
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeVisible()
	await expect(page.getByPlaceholder('Send a message…')).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Create your first thread' }),
	).toHaveCount(0)
})

test('desktop /chat redirects to the first thread when one exists', async ({
	page,
	login,
}) => {
	await login()
	await createThread(page, `desktop redirect test ${Date.now()}`)

	await page.goto('/chat')

	await expect(page).toHaveURL(/\/chat\/.+/)
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeVisible()
	await expect(page.getByPlaceholder('Send a message…')).toBeVisible()
})

test('mobile /chat uses URL-driven single-panel navigation', async ({
	page,
	login,
}) => {
	await login()
	await createThread(page, `mobile routing test ${Date.now()}`)
	await page.setViewportSize({ width: 390, height: 844 })

	await page.goto('/chat')

	await expect(page).toHaveURL(/\/chat$/)
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeVisible()
	await expect(page.getByPlaceholder('Send a message…')).toBeHidden()

	await page
		.locator('#chat-thread-list-scroll-container')
		.getByRole('button')
		.first()
		.click()

	await expect(page).toHaveURL(/\/chat\/.+/)
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeHidden()
	await expect(page.getByRole('link', { name: 'Back to chats' })).toBeVisible()
	await expect(page.getByPlaceholder('Send a message…')).toBeVisible()

	await page.getByRole('link', { name: 'Back to chats' }).click()

	await expect(page).toHaveURL(/\/chat$/)
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('link', { name: 'Back to chats' })).toHaveCount(0)

	await page.setViewportSize({ width: 1280, height: 900 })

	await expect(page).toHaveURL(/\/chat\/.+/)
	await expect(page.getByPlaceholder('Send a message…')).toBeVisible()
})

test('creates and deletes chat threads when authenticated', async ({
	page,
	login,
}) => {
	await login()
	await createThread(page, 'Hello there')
	const createdThreadPath = new URL(page.url()).pathname
	await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
	await expect(
		page
			.locator('#chat-messages-scroll-container')
			.getByText('This is a mock completion', { exact: false }),
	).toBeVisible()
	await expect(
		page.locator('#chat-messages-scroll-container').getByText('Hello there'),
	).toBeVisible()

	await page
		.getByRole('complementary')
		.getByRole('button', { name: 'Delete' })
		.first()
		.click({ force: true })
	await page.getByRole('button', { name: /confirm delete chat/i }).click()
	await expect(page).not.toHaveURL(new RegExp(`${createdThreadPath}$`))
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
})

test('responds to mock tool commands in chat', async ({ page, login }) => {
	await login()
	await page.goto('/chat')
	await page.getByRole('button', { name: 'New thread' }).click()
	await expect(page).toHaveURL(/\/chat\/.+/)
	const messages = page.locator('#chat-messages-scroll-container')

	await page
		.getByRole('textbox', { name: 'Message' })
		.fill(
			'tool:open_generated_ui;code=<main><h1>Mock App</h1><p>Opened from chat.</p></main>;title=Mock App',
		)
	await page.getByRole('button', { name: 'Send message' }).click()

	await expect(page).toHaveURL(/\/chat\/.+/)
	await expect(
		messages
			.getByText(
				'tool:open_generated_ui;code=<main><h1>Mock App</h1><p>Opened from chat.</p></main>;title=Mock App',
			)
			.last(),
	).toBeVisible()
	await expect(
		messages.getByText('## Generated UI ready', { exact: false }).last(),
	).toBeVisible()
	await expect(
		messages.getByText('The generated UI is attached', { exact: false }).last(),
	).toBeVisible()
})
