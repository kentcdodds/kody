import { expect, test } from 'vitest'
import { applyImportStoragePage } from '#worker/storage-runner.ts'

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

test('importStorage first page clears then writes; continue pages append', async () => {
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
})

test('importStorage first page again restarts the replace', async () => {
	const storage = createMemoryStorage()
	await applyImportStoragePage(storage, {
		mode: 'replace',
		replacePage: 'first',
		entries: [{ key: 'old', valueJson: '"x"' }],
	})
	await applyImportStoragePage(storage, {
		mode: 'replace',
		replacePage: 'first',
		entries: [{ key: 'new', valueJson: '"y"' }],
	})
	expect([...storage.map.keys()]).toEqual(['new'])
})

test('importStorage rejects invalid valueJson', async () => {
	const storage = createMemoryStorage()
	await expect(
		applyImportStoragePage(storage, {
			mode: 'replace',
			replacePage: 'first',
			entries: [{ key: 'bad', valueJson: '{not-json' }],
		}),
	).rejects.toThrow(/invalid valueJson/)
})
