import {
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { runD1RestoreDrill } from './d1-restore-drill.ts'
import {
	collectBackupFileEvidence,
	stageBackupFile,
	withStagedBackupFile,
} from './d1-restore-drill-cli.ts'
import {
	backupBytes,
	createAdapters,
	drillInput,
} from './disaster-recovery-test-support.ts'
import { sha256 } from './canonical-json.ts'

test('SQL file evidence streams injected chunks after stat and rejects sizes without reading the dump', async () => {
	const events: Array<string> = []
	const evidence = await collectBackupFileEvidence('backup.sql', 6, {
		async statFile(file) {
			events.push(`stat:${file}`)
			return { size: 6 }
		},
		readChunks(file) {
			events.push(`stream:${file}`)
			return (async function* () {
				yield new TextEncoder().encode('back')
				yield new TextEncoder().encode('up')
			})()
		},
	})
	expect(evidence).toEqual({
		sizeBytes: 6,
		sha256: sha256(backupBytes),
	})
	expect(events).toEqual(['stat:backup.sql', 'stream:backup.sql'])
	await expect(
		runD1RestoreDrill(
			drillInput({ backupFileEvidence: evidence }),
			createAdapters(),
		),
	).resolves.toMatchObject({ dryRun: true })

	const readChunks = vi.fn((): AsyncIterable<Uint8Array> => {
		throw new Error('dump stream must not be opened')
	})
	await expect(
		collectBackupFileEvidence('backup.sql', 7, {
			async statFile() {
				return { size: 6 }
			},
			readChunks,
		}),
	).rejects.toThrow('size does not match the manifest')
	await expect(
		collectBackupFileEvidence('backup.sql', 5 * 1024 * 1024 * 1024, {
			async statFile() {
				return { size: 5 * 1024 * 1024 * 1024 }
			},
			readChunks,
		}),
	).rejects.toThrow('exceeds the 5 GiB')
	expect(readChunks).not.toHaveBeenCalled()
})

test('staged SQL remains immutable when the operator path is replaced before Wrangler runs', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'restore-source-'))
	const source = path.join(directory, 'operator.sql')
	await writeFile(source, backupBytes)
	let stagedPath = ''
	try {
		await withStagedBackupFile(
			source,
			{ sizeBytes: backupBytes.byteLength, sha256: sha256(backupBytes) },
			async (staged) => {
				stagedPath = staged.path
				await rm(source)
				await writeFile(source, 'evil!!')
				expect(await readFile(staged.path)).toEqual(Buffer.from(backupBytes))
				expect((await stat(path.dirname(staged.path))).mode & 0o777).toBe(0o700)
				expect((await stat(staged.path)).mode & 0o777).toBe(0o400)

				const adapters = createAdapters()
				adapters.run = vi.fn(async (command) => {
					expect(command.args).toContain(staged.path)
					expect(command.args).not.toContain(source)
					expect(await readFile(command.args.at(-1)!)).toEqual(
						Buffer.from(backupBytes),
					)
				})
				const result = await runD1RestoreDrill(
					drillInput({
						backupFile: staged.path,
						backupFileEvidence: staged.evidence,
						dryRun: false,
					}),
					adapters,
				)
				expect(result.commands[1]?.args).toContain(staged.path)
				expect(result.commands[1]?.args).not.toContain(source)
			},
		)
		await expect(stat(stagedPath)).rejects.toThrow()
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('staging hash mismatch cleans the snapshot and never starts target creation', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'restore-mismatch-'))
	const source = path.join(directory, 'operator.sql')
	await writeFile(source, backupBytes)
	const createTarget = vi.fn()
	const before = new Set(
		(await readdir(os.tmpdir())).filter((entry) =>
			entry.startsWith('kody-d1-sql-'),
		),
	)
	try {
		await expect(
			withStagedBackupFile(
				source,
				{ sizeBytes: backupBytes.byteLength, sha256: 'f'.repeat(64) },
				async () => {
					createTarget()
				},
				stageBackupFile,
			),
		).rejects.toThrow('staged SQL file evidence does not match the manifest')
		expect(createTarget).not.toHaveBeenCalled()
		const after = (await readdir(os.tmpdir())).filter((entry) =>
			entry.startsWith('kody-d1-sql-'),
		)
		expect(after.filter((entry) => !before.has(entry))).toEqual([])
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
