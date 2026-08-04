import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { mailboxPreDropApprovalColumns } from '@kody-internal/shared/mailbox-pre-drop-approval.ts'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
	migrationsDirectory,
} from '#worker/test-support/system-email-graph-migration.ts'

const dropMigration = '0135-drop-legacy-email-graph.sql'

function maximumFunctionArguments(sql: string): number {
	const functions = new Set([
		'count',
		'group_concat',
		'julianday',
		'length',
		'lower',
		'replace',
		'strftime',
		'substr',
	])
	let maximum = 0
	for (let index = 0; index < sql.length; index += 1) {
		if (sql[index] !== '(') continue
		const prefix = sql.slice(0, index).match(/([a-z_]+)\s*$/iu)
		if (!prefix?.[1] || !functions.has(prefix[1].toLowerCase())) continue
		let depth = 1
		let argumentsCount = 1
		let quoted = false
		for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
			const character = sql[cursor]
			if (character === "'") {
				if (quoted && sql[cursor + 1] === "'") {
					cursor += 1
					continue
				}
				quoted = !quoted
				continue
			}
			if (quoted) continue
			if (character === '(') depth += 1
			if (character === ')') {
				depth -= 1
				if (depth === 0) break
			}
			if (character === ',' && depth === 1) argumentsCount += 1
		}
		maximum = Math.max(maximum, argumentsCount)
	}
	return maximum
}

test('0135 SQL stays within D1 expression limits and consumes the canonical approval', () => {
	const sql = readFileSync(new URL(dropMigration, migrationsDirectory), 'utf8')
	expect(sql).not.toMatch(/\bjson_array\s*\(/iu)
	expect(maximumFunctionArguments(sql)).toBeLessThanOrEqual(32)
	const maximumCompoundTerms = Math.max(
		...sql
			.split(';')
			.map(
				(statement) =>
					(statement.match(/\b(?:union|intersect|except)\b/giu)?.length ?? 0) +
					1,
			),
	)
	expect(maximumCompoundTerms).toBeLessThanOrEqual(10)
	for (const column of mailboxPreDropApprovalColumns) {
		expect(sql, `approval column ${column} is not consumed`).toMatch(
			new RegExp(`\\bapproval\\.${column}\\b`, 'u'),
		)
	}
})

test('0135 removes every retired Mailbox parity users column and index', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, dropMigration)
	applyMigrationLikeD1(db, dropMigration)

	// Replay, backfill, and soak fields introduced by 0125 all share this
	// literal prefix.
	expect(
		db
			.prepare(
				`SELECT name
				FROM pragma_table_xinfo('users')
				WHERE name GLOB 'mailbox_parity_*'
				ORDER BY name`,
			)
			.all(),
	).toEqual([])
	expect(
		db
			.prepare(
				`SELECT name
				FROM pragma_index_list('users')
				WHERE name = 'idx_users_mailbox_parity_checked'`,
			)
			.all(),
	).toEqual([])
})

test('dedicated system runtime has no dropped shared-graph reference', () => {
	const emailDirectory = fileURLToPath(new URL('.', import.meta.url))
	const references = readdirSync(emailDirectory)
		.filter(
			(fileName) =>
				fileName.startsWith('system-') &&
				fileName.endsWith('.ts') &&
				!fileName.includes('.test.'),
		)
		.flatMap((fileName) => {
			const source = readFileSync(join(emailDirectory, fileName), 'utf8')
			return /\bemail_(?:threads|messages|attachments|delivery_events)\b/u.test(
				source,
			)
				? [fileName]
				: []
		})
	expect(references).toEqual([])
})
