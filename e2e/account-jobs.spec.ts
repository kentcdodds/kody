import { expect, test } from './playwright-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { executeE2eD1Command } from './d1-utils.ts'

function insertJob(input: {
	userId: string
	jobId: string
	jobName: string
	schedule: Record<string, string>
	enabled: 0 | 1
	nextRunAt: string
	now: string
}) {
	executeE2eD1Command(
		`INSERT INTO jobs (
			id, user_id, name, source_id, published_commit, storage_id,
			params_json, schedule_json, timezone, enabled, kill_switch_enabled,
			caller_context_json, created_at, updated_at, next_run_at,
			run_count, success_count, error_count
		) VALUES (
			${quoteSqlString(input.jobId)},
			${quoteSqlString(input.userId)},
			${quoteSqlString(input.jobName)},
			${quoteSqlString(`source-${input.jobId}`)},
			NULL,
			${quoteSqlString(`job:${input.jobId}`)},
			NULL,
			${quoteSqlString(JSON.stringify(input.schedule))},
			'UTC',
			${input.enabled},
			0,
			'null',
			${quoteSqlString(input.now)},
			${quoteSqlString(input.now)},
			${quoteSqlString(input.nextRunAt)},
			0,
			0,
			0
		)`,
	)
}

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
	insertJob({
		userId,
		jobId,
		jobName,
		schedule: { type: 'interval', every: '1h' },
		enabled: 1,
		nextRunAt,
		now,
	})

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

test('account jobs defaults to active view and can show history', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const email = `account-jobs-filter-${runId}@example.com`
	const user = await seedE2eUser({
		email,
		username: `account-jobs-filter-${runId}`,
		password: 'account-jobs-password',
	})
	const userId = await createStableUserIdFromEmail(email)
	const now = new Date().toISOString()
	const activeJobId = crypto.randomUUID()
	const activeJobName = `Active job ${runId}`
	const historyJobId = crypto.randomUUID()
	const historyJobName = `Past once job ${runId}`
	insertJob({
		userId,
		jobId: activeJobId,
		jobName: activeJobName,
		schedule: { type: 'cron', expression: '0 9 * * *' },
		enabled: 1,
		nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		now,
	})
	insertJob({
		userId,
		jobId: historyJobId,
		jobName: historyJobName,
		schedule: {
			type: 'once',
			runAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
		},
		enabled: 0,
		nextRunAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
		now,
	})

	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto('/account/jobs')
	await expect(
		page.getByRole('heading', { name: 'Jobs', exact: true }),
	).toBeVisible()
	await expect(page.getByLabel('Jobs view filter')).toHaveValue('active')
	await expect(page.getByText(activeJobName, { exact: true })).toBeVisible()
	await expect(page.getByText(historyJobName, { exact: true })).toHaveCount(0)

	await page.getByLabel('Jobs view filter').selectOption('history')
	await expect(page).toHaveURL(/view=history/)
	await expect(page.getByText(historyJobName, { exact: true })).toBeVisible()
	await expect(page.getByText(activeJobName, { exact: true })).toHaveCount(0)
})
