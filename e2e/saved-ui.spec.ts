import { expect, test } from './playwright-utils.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { Shell } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(require('node:child_process').execFile)

async function seedSavedUi(options: {
	appId: string
	userId: string
	title: string
	description: string
	code: string
}) {
	const sql = [
		'INSERT OR REPLACE INTO ui_artifacts (',
		"id, user_id, title, description, keywords, source_type, source_code, search_text, created_at, updated_at",
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

	await execFile('bun', [
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
	], {
		cwd: process.cwd(),
	})
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
		code: '<main><h1>Hosted saved ui</h1><button type="button" id="run">Run</button><script>document.getElementById("run")?.addEventListener("click", async () => { const result = await window.kodyWidget.executeCode("async () => ({ ok: true, source: \\"saved-ui\\" })"); const pre = document.createElement("pre"); pre.textContent = JSON.stringify(result); document.body.append(pre); });</script></main>',
	})
	await login()

	await page.goto(`/ui/${appId}`)

	await expect(page.getByRole('heading', { name: 'Hosted saved ui' })).toBeVisible()
	const shellFrame = page.frameLocator('[data-saved-ui-shell]')
	await expect(
		shellFrame.getByRole('heading', { name: 'Hosted saved ui' }),
	).toBeVisible()
	await shellFrame.getByRole('button', { name: 'Run' }).click()
	await expect(shellFrame.getByText('"source":"saved-ui"')).toBeVisible()
})

test('saved ui route redirects unauthenticated users to login', async ({ page }) => {
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
