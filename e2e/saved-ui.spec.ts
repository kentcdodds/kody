import { expect, test } from './playwright-utils.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

test.describe.configure({ mode: 'serial' })

async function seedSavedUi(options: {
	appId: string
	userId: string
	title: string
	description: string
	code: string
}) {
	const sql = [
		'INSERT OR REPLACE INTO ui_artifacts (',
		'id, user_id, title, description, keywords, source_type, source_code, search_text, created_at, updated_at',
		') VALUES (',
		`'${options.appId}',`,
		`'${options.userId}',`,
		`'${options.title.replaceAll("'", "''")}',`,
		`'${options.description.replaceAll("'", "''")}',`,
		`'["saved-ui"]',`,
		"'html',",
		`'${options.code.replaceAll("'", "''")}',`,
		"'saved ui route e2e',",
		'CURRENT_TIMESTAMP,',
		'CURRENT_TIMESTAMP',
		');',
	].join(' ')

	let lastError: unknown = null
	for (const delayMs of [0, 150, 300, 600]) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		try {
			await execFile(
				'bun',
				[
					'--no-env-file',
					'--env-file=packages/worker/.env',
					'./wrangler-env.ts',
					'd1',
					'execute',
					'APP_DB',
					'--local',
					'--persist-to',
					'.wrangler/state/e2e',
					'--command',
					sql,
				],
				{
					cwd: process.cwd(),
				},
			)
			return
		} catch (error) {
			lastError = error
			const message = error instanceof Error ? error.message : String(error)
			if (!message.includes('database is locked')) {
				throw error
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error('Unable to seed saved UI into the e2e database.')
}

test('authenticated user can open their hosted saved ui route', async ({
	page,
	login,
}) => {
	const appId = `saved-ui-${Date.now()}`
	await seedSavedUi({
		appId,
		userId: '1',
		title: 'Hosted saved ui',
		description: 'Saved ui route test artifact',
		code: '<main><h1>Hosted saved ui</h1><p>Saved UI route e2e body</p></main>',
	})
	await login()

	await page.goto(`/ui/${appId}`)

	await expect(
		page.getByRole('heading', { name: 'Hosted saved ui' }),
	).toBeVisible()
	// Shell page is one iframe; the saved app document is nested inside
	// `[data-generated-ui-frame]` (see generated-ui-shell entry HTML).
	const shellFrame = page.frameLocator('[data-saved-ui-shell]')
	const appFrame = shellFrame.frameLocator('[data-generated-ui-frame]')
	await expect(
		appFrame.getByRole('heading', { name: 'Hosted saved ui' }),
	).toBeVisible()
	await expect(appFrame.getByText('Saved UI route e2e body')).toBeVisible()
})

test('saved ui route redirects unauthenticated users to login', async ({
	page,
}) => {
	const appId = `saved-ui-redirect-${Date.now()}`
	const emailOwnerId = await createStableUserIdFromEmail('me@kentcdodds.com')
	await seedSavedUi({
		appId,
		userId: emailOwnerId,
		title: 'Redirect saved ui',
		description: 'Saved ui auth redirect test',
		code: '<main><h1>Redirect saved ui</h1></main>',
	})

	await page.context().clearCookies()
	await page.goto(`/ui/${appId}`)
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Fui%2F/)
})
