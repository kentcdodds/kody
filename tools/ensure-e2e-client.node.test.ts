import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { ensureE2eClientBuilt } from './ensure-e2e-client.ts'

test('ensureE2eClientBuilt builds only when the client bundle is missing', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'kody-e2e-client-'))
	try {
		const missingPath = path.join(dir, 'missing', 'client-entry.js')
		const existingPath = path.join(dir, 'client-entry.js')
		await writeFile(existingPath, 'ok')

		const builtWhenMissing: Array<string> = []
		ensureE2eClientBuilt({
			clientEntryPath: missingPath,
			build: () => {
				builtWhenMissing.push(missingPath)
			},
		})
		expect(builtWhenMissing).toEqual([missingPath])

		ensureE2eClientBuilt({
			clientEntryPath: existingPath,
			build: () => {
				throw new Error('should not rebuild an existing client bundle')
			},
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
