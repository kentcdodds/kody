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

test('static authority permits Mailbox SQLite and scoped cleanup SQL', async () => {
	await using fixture = await authorityFixture({
		'packages/worker/src/email/mailbox-store.ts': `
			export function read(sql: SqlStorage) {
				return sql.exec('SELECT * FROM email_messages')
			}
		`,
		'packages/worker/src/email/legacy-user-email-graph-cleanup.ts': `
			export function remove(db: D1Database) {
				return db.prepare(\`DELETE FROM email_messages WHERE id = ?\`)
			}
		`,
	})
	await expect(scanUserEmailD1Authority(fixture.root)).resolves.toEqual([])
})
