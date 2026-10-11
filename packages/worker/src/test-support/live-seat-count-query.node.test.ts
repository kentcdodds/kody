import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { liveFreeOwnedOrgCountSql } from '#worker/orgs/billing.ts'
import {
	isLiveSeatCountQuery,
	mockLiveSeatCountRow,
} from './live-seat-count-query.ts'

function countLiveSeatsSql() {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '../orgs/billing.ts'),
		'utf8',
	)
	const start = source.indexOf('export async function countLiveSeats')
	const slice = source.slice(start, start + 800)
	const match = slice.match(/prepare\(\s*`([^`]+)`/)
	if (start < 0 || !match?.[1]) {
		throw new Error('countLiveSeats SQL not found in orgs/billing.ts')
	}
	return match[1]
}

test('isLiveSeatCountQuery matches countLiveSeats and fixture seat rows', () => {
	const sql = countLiveSeatsSql()
	expect(isLiveSeatCountQuery(sql)).toBe(true)
	expect(isLiveSeatCountQuery(sql.toLowerCase())).toBe(true)
	expect(isLiveSeatCountQuery(sql.replace(/\s+/g, ' ').trim())).toBe(true)
	expect(mockLiveSeatCountRow()).toEqual({ count: 1 })
	expect(mockLiveSeatCountRow(4)).toEqual({ count: 4 })
})

test('isLiveSeatCountQuery ignores other org_memberships statements', () => {
	const queries = [
		`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.org_id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		`SELECT user_id
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role IN ('owner', 'billing')
			   AND deleted_at IS NULL`,
		`SELECT (${liveFreeOwnedOrgCountSql}) AS count`,
		`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		`SELECT COUNT(*) AS count FROM org_memberships WHERE user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		'FROM org_memberships',
		`${countLiveSeatsSql()} AND m.user_id = ?`,
	]
	for (const query of queries) {
		expect(isLiveSeatCountQuery(query)).toBe(false)
	}
})
