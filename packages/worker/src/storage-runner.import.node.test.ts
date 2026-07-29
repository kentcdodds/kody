import { expect, test } from 'vitest'
import {
	applyImportStoragePage,
	readStorageEstimateWithRetry,
} from '#worker/storage-runner.ts'

function createMemoryStorage(seed: Record<string, unknown> = {}) {
	const map = new Map<string, unknown>(Object.entries(seed))
	return {
		map,
		async deleteAll() {
			map.clear()
		},
		async put(key: string, value: unknown) {
			map.set(key, value)
		},
	}
}

test('importStorage replace workflow clears, appends, restarts, and rejects invalid JSON', async () => {
	const storage = createMemoryStorage({ stale: true, keep: 'old' })

	const first = await applyImportStoragePage(storage, {
		mode: 'replace',
		replacePage: 'first',
		entries: [
			{ key: 'a', valueJson: JSON.stringify({ n: 1 }) },
			{ key: 'b', valueJson: JSON.stringify('two') },
		],
	})
	expect(first).toEqual({ ok: true, written: 2, cleared: true })
	expect(storage.map.has('stale')).toBe(false)
	expect(storage.map.get('a')).toEqual({ n: 1 })
	expect(storage.map.get('b')).toBe('two')

	const second = await applyImportStoragePage(storage, {
		mode: 'replace',
		replacePage: 'continue',
		entries: [{ key: 'c', valueJson: JSON.stringify(3) }],
	})
	expect(second).toEqual({ ok: true, written: 1, cleared: false })
	expect(storage.map.get('a')).toEqual({ n: 1 })
	expect(storage.map.get('c')).toBe(3)

	await applyImportStoragePage(storage, {
		mode: 'replace',
		replacePage: 'first',
		entries: [{ key: 'new', valueJson: '"y"' }],
	})
	expect([...storage.map.keys()]).toEqual(['new'])

	await expect(
		applyImportStoragePage(storage, {
			mode: 'replace',
			replacePage: 'first',
			entries: [{ key: 'bad', valueJson: '{not-json' }],
		}),
	).rejects.toThrow(/invalid valueJson/)
})

test('storage estimate reads retry individual transient failures and fail closed after exhaustion', async () => {
	let transientAttempts = 0
	await expect(
		readStorageEstimateWithRetry({
			storageId: 'package:transient',
			async getEstimatedBytes() {
				transientAttempts += 1
				if (transientAttempts < 3) {
					throw new Error(`transient RPC failure ${transientAttempts}`)
				}
				return { estimatedBytes: 4_096 }
			},
		}),
	).resolves.toEqual({ estimatedBytes: 4_096 })
	expect(transientAttempts).toBe(3)

	let exhaustedAttempts = 0
	let finalCause: Error | null = null
	const exhausted = await readStorageEstimateWithRetry({
		storageId: 'package:"unreadable"',
		async getEstimatedBytes() {
			exhaustedAttempts += 1
			finalCause = new Error(`RPC failure ${exhaustedAttempts}`)
			throw finalCause
		},
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(exhaustedAttempts).toBe(3)
	expect(exhausted).toBeInstanceOf(Error)
	expect((exhausted as Error).message).toBe(
		'Unable to verify the storage byte entitlement because the bucket estimate for storageId "package:\\"unreadable\\"" could not be read after 3 attempts.',
	)
	expect((exhausted as Error).cause).toBe(finalCause)
})
