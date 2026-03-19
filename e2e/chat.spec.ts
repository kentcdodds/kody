import { expect, test, type Page } from './playwright-utils.ts'

async function createThread(page: Page, title: string) {
	const createResponse = await page.request.post('/chat-threads')
	expect(createResponse.ok()).toBeTruthy()

	const createPayload = (await createResponse.json()) as {
		thread?: { id?: string }
	}
	const threadId = createPayload.thread?.id
	expect(threadId).toBeTruthy()

	const renameResponse = await page.request.post('/chat-threads/update', {
		data: { threadId, title },
		headers: { 'Content-Type': 'application/json' },
	})
	expect(renameResponse.ok()).toBeTruthy()

	return threadId as string
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
	const threadId = await createThread(page, `desktop-thread-${Date.now()}`)

	await page.goto('/chat')

	await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`))
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
	await page.setViewportSize({ width: 390, height: 844 })
	const threadTitle = `mobile-thread-${Date.now()}`
	const threadId = await createThread(page, threadTitle)

	await page.goto('/chat')

	await expect(page).toHaveURL(/\/chat$/)
	await expect(
		page.getByRole('heading', { name: 'Chats', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0)

	await page.getByRole('button', { name: new RegExp(threadTitle) }).click()

	await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`))
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
})

test('creates and deletes chat threads when authenticated', async ({
	page,
	login,
}) => {
	await login()
	await page.goto('/chat')

	await page.getByRole('textbox', { name: 'Message' }).fill('Hello there')
	await page.getByRole('button', { name: 'Send message' }).click()
	await expect(page).toHaveURL(/\/chat\/.+/)
	const createdThreadPath = new URL(page.url()).pathname
	await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
	await expect(
		page
			.getByRole('complementary')
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
	await expect(page.getByRole('heading', { name: 'New chat' })).toHaveCount(0)
})

test('responds to mock tool commands in chat', async ({ page, login }) => {
	await login()
	await page.goto('/chat')

	await page
		.getByRole('textbox', { name: 'Message' })
		.fill('tool:do_math;left=1;right=2;operator=+')
	await page.getByRole('button', { name: 'Send message' }).click()

	await expect(page).toHaveURL(/\/chat\/.+/)
	await expect(
		page
			.locator('#chat-messages-scroll-container')
			.getByText('tool:do_math;left=1;right=2;operator=+'),
	).toBeVisible()
	await expect(
		page
			.locator('#chat-messages-scroll-container')
			.getByText('## ✅ Result', { exact: false }),
	).toBeVisible()
	await expect(
		page
			.locator('#chat-messages-scroll-container')
			.getByText('**Result**: `3`', { exact: false }),
	).toBeVisible()
})
