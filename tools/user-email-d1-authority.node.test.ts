import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { scanUserEmailD1Authority } from './user-email-d1-authority.ts'

async function authorityFixture(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), 'user-email-authority-'))
	for (const [file, contents] of Object.entries(files)) {
		const absolute = path.join(root, file)
		await mkdir(path.dirname(absolute), { recursive: true })
		await writeFile(absolute, contents)
	}
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

test('production USER email graph D1 references stay inside static authority boundaries', async () => {
	const violations = await scanUserEmailD1Authority()
	expect(violations).toEqual([])
})

test('static authority catches live and mailbox-named D1 graph SQL', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/live-flow.ts': `
			export function read(db: D1Database) {
				return db.prepare('SELECT * FROM email_messages')
			}
		`,
		'packages/worker/src/email/mailbox-escape.ts': `
			export function write(db: D1Database) {
				return db.prepare('DELETE FROM "email_threads"')
			}
		`,
	})
	const violations = await scanUserEmailD1Authority(fixture.root)
	expect(violations).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				file: 'packages/worker/src/email/live-flow.ts',
				message: expect.stringContaining('shared USER graph D1 SQL'),
			}),
			expect.objectContaining({
				file: 'packages/worker/src/email/mailbox-escape.ts',
				message: expect.stringContaining('shared USER graph D1 SQL'),
			}),
		]),
	)
})

test('static authority catches quoted, qualified, TSX, and system-prefix SQL bypasses', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/qualified.ts': `
			export const read = (db: D1Database) =>
				db.prepare('SELECT * FROM main.email_messages')
		`,
		'packages/worker/src/email/double-quoted.ts': `
			export const read = (db: D1Database) =>
				db.prepare('SELECT * FROM "main"."email_threads"')
		`,
		'packages/worker/src/email/bracketed.ts': `
			export const read = (db: D1Database) =>
				db.prepare('SELECT * FROM [main].[email_attachments]')
		`,
		'packages/worker/src/email/backtick.ts': `
			export const read = (db: D1Database) =>
				db.prepare('SELECT * FROM \`main\`.\`email_delivery_events\`')
		`,
		'packages/worker/src/email/single-quoted.tsx': `
			export const read = (db: D1Database) =>
				db.prepare("SELECT * FROM 'main'.'email_messages'")
		`,
		'packages/worker/src/email/system-escape.ts': `
			export const read = (db: D1Database) =>
				db.prepare('DELETE FROM email_threads')
		`,
	})
	const violations = await scanUserEmailD1Authority(fixture.root)
	for (const file of [
		'qualified.ts',
		'double-quoted.ts',
		'bracketed.ts',
		'backtick.ts',
		'single-quoted.tsx',
		'system-escape.ts',
	]) {
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: `packages/worker/src/email/${file}`,
				}),
			]),
		)
	}
})

test('static authority catches every legacy import shape and mutator aliases', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/default-import.ts': `
			import repo from './repo.ts'
			export { repo }
		`,
		'packages/worker/src/email/namespace-import.ts': `
			import * as repo from './repo.ts'
			export { repo }
		`,
		'packages/worker/src/email/named-alias.ts': `
			import { insertEmailMessage as hiddenWrite } from './repo.ts'
			export { hiddenWrite }
		`,
		'packages/worker/src/email/dynamic-import.ts': `
			export const load = () => import('#worker/email/repo.ts')
		`,
		'packages/worker/src/email/retired-import.ts': `
			import { mirror } from './mailbox-live-mirror.ts'
			export { mirror }
		`,
		'packages/worker/src/email/cleanup-import.ts': `
			import { deleteFrozenUserEmailGraphForAccount } from './legacy-user-email-graph-cleanup.ts'
			export { deleteFrozenUserEmailGraphForAccount }
		`,
	})
	const violations = await scanUserEmailD1Authority(fixture.root)
	for (const file of [
		'default-import.ts',
		'namespace-import.ts',
		'named-alias.ts',
		'dynamic-import.ts',
		'retired-import.ts',
		'cleanup-import.ts',
	]) {
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: `packages/worker/src/email/${file}`,
					message: expect.stringContaining('imports'),
				}),
			]),
		)
	}
})

test('static authority rejects dynamic D1 SQL composition, including batched statements', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/template-expression.ts': `
			export const read = (db: D1Database, table: string) =>
				db.prepare(\`SELECT * FROM \${table}\`)
		`,
		'packages/worker/src/email/concatenated.ts': `
			export const read = (db: D1Database, suffix: string) =>
				db.prepare('SELECT * FROM email_' + suffix)
		`,
		'packages/worker/src/email/nonliteral-variable.ts': `
			export const read = (db: D1Database, sql: string) => db.prepare(sql)
		`,
		'packages/worker/src/email/helper-composed.ts': `
			const tableSql = (table: string) => \`SELECT * FROM \${table}\`
			export const read = (db: D1Database) =>
				db.prepare(tableSql('email_messages'))
		`,
		'packages/worker/src/email/batched.ts': `
			export const write = (env: Env, table: string) =>
				env.APP_DB.batch([
					env.APP_DB.prepare(\`DELETE FROM \${table} WHERE user_id = ?\`),
				])
		`,
		'packages/worker/src/email/exec-template.ts': `
			export const write = (db: D1Database, table: string) =>
				db.exec(\`DELETE FROM \${table}\`)
		`,
		'packages/worker/src/email/exec-concatenated.ts': `
			export const write = (db: D1Database, suffix: string) =>
				db.exec('DELETE FROM email_' + suffix)
		`,
	})
	const violations = await scanUserEmailD1Authority(fixture.root)
	for (const file of [
		'template-expression.ts',
		'concatenated.ts',
		'nonliteral-variable.ts',
		'helper-composed.ts',
		'batched.ts',
		'exec-template.ts',
		'exec-concatenated.ts',
	]) {
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: `packages/worker/src/email/${file}`,
					message: expect.stringContaining('inline string literal'),
				}),
			]),
		)
	}
})

test('static authority permits Mailbox SQLite and scoped cleanup SQL', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/mailbox-store.ts': `
			export function read(sql: SqlStorage, statement: string) {
				return sql.exec(statement)
			}
		`,
		'packages/worker/src/email/legacy-user-email-graph-cleanup.ts': `
			export function remove(db: D1Database) {
				return db.prepare(\`DELETE FROM email_messages WHERE id = ?\`)
			}
		`,
		'packages/worker/src/email/system-email-graph-store.ts': `
			export function read(db: D1Database, table: string) {
				return db.prepare(\`SELECT * FROM \${table}\`)
			}
		`,
		'packages/worker/src/email/unrelated.tsx': `
			// SELECT * FROM email_messages is documentation, not executable SQL.
			export const tableLabel = 'email_messages'
			export const projection = "SELECT 'email_messages' AS label"
		`,
	})
	await expect(scanUserEmailD1Authority(fixture.root)).resolves.toEqual([])
})
