import { expect, test } from './playwright-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { executeE2eD1Command } from './d1-utils.ts'

test('account memories detail URL shows a seeded memory', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const email = `account-memories-detail-${runId}@example.com`
	const user = await seedE2eUser({
		email,
		username: `account-memories-detail-${runId}`,
		password: 'account-memories-password',
	})
	const userId = await createStableUserIdFromEmail(email)
	const memoryId = crypto.randomUUID()
	const now = new Date().toISOString()
	executeE2eD1Command(
		`INSERT INTO mcp_memories (
			id, user_id, category, status, subject, summary, details, tags_json,
			source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
		) VALUES (
			${quoteSqlString(memoryId)},
			${quoteSqlString(userId)},
			'preferences',
			'active',
			${quoteSqlString(`Seeded memory ${runId}`)},
			'Seeded for account memories e2e coverage.',
			'Details for the seeded memory.',
			${quoteSqlString(JSON.stringify(['e2e']))},
			${quoteSqlString(JSON.stringify(['https://example.com/seeded-memory']))},
			${quoteSqlString(`e2e:memory:${runId}`)},
			${quoteSqlString(now)},
			${quoteSqlString(now)},
			NULL,
			NULL
		)`,
	)

	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto(`/account/memories/${memoryId}`)
	await expect(
		page.getByRole('heading', { name: 'Memories', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', {
			name: `Seeded memory ${runId}`,
			exact: true,
		}),
	).toBeVisible()
	await expect(page.getByText('Details for the seeded memory.')).toBeVisible()
})
