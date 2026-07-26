import { expect, test } from './playwright-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { executeE2eD1Command } from './d1-utils.ts'

test('account jobs detail URL persists across reload for a seeded job', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const email = `account-jobs-detail-${runId}@example.com`
	const user = await seedE2eUser({
		email,
		username: `account-jobs-detail-${runId}`,
		password: 'account-jobs-password',
	})
	const userId = await createStableUserIdFromEmail(email)
	const jobId = crypto.randomUUID()
	const jobName = `Seeded job ${runId}`
	const now = new Date().toISOString()
	const nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
	executeE2eD1Command(
		`INSERT INTO jobs (
			id, user_id, name, source_id, published_commit, storage_id,
			params_json, schedule_json, timezone, enabled, kill_switch_enabled,
			caller_context_json, created_at, updated_at, next_run_at,
			run_count, success_count, error_count
		) VALUES (
			${quoteSqlString(jobId)},
			${quoteSqlString(userId)},
			${quoteSqlString(jobName)},
			${quoteSqlString(`source-${jobId}`)},
			NULL,
			${quoteSqlString(`job:${jobId}`)},
			NULL,
			${quoteSqlString(JSON.stringify({ type: 'interval', every: '1h' }))},
			'UTC',
			1,
			0,
			'null',
			${quoteSqlString(now)},
			${quoteSqlString(now)},
			${quoteSqlString(nextRunAt)},
			0,
			0,
			0
		)`,
	)

	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto(`/account/jobs/${encodeURIComponent(jobId)}`)
	await expect(
		page.getByRole('heading', { name: 'Jobs', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: jobName, exact: true }),
	).toBeVisible()

	const detailUrl = page.url()
	await page.reload()
	await expect(page).toHaveURL(detailUrl)
	await expect(
		page.getByRole('heading', { name: jobName, exact: true }),
	).toBeVisible()
})
