import { expect, test } from 'vitest'
import {
	createInfiniteList,
	type InfiniteListSnapshot,
} from './infinite-list.ts'

type Item = { id: number }

function createList() {
	let snapshot: InfiniteListSnapshot<Item> | null = null
	const list = createInfiniteList<Item>({
		mergeDirection: 'append',
		getKey: (item) => String(item.id),
		onSnapshot: (nextSnapshot) => {
			snapshot = nextSnapshot
		},
	})
	return { list, getSnapshot: () => snapshot ?? list.getSnapshot() }
}

test('loadMore appends, dedupes overlap, and tracks hasMore', async () => {
	const { list, getSnapshot } = createList()

	await list.loadInitial(async () => ({
		items: [{ id: 1 }, { id: 2 }],
		hasMore: true,
		totalCount: 3,
	}))
	expect(getSnapshot().items.map((item) => item.id)).toEqual([1, 2])
	expect(getSnapshot().hasMore).toBe(true)

	// Overlapping windows (an item created while scrolling shifts offsets)
	// must not produce duplicate rows.
	const loaded = await list.loadMore(async () => ({
		items: [{ id: 2 }, { id: 3 }],
		hasMore: false,
		totalCount: 3,
	}))
	expect(loaded).toBe(true)
	expect(getSnapshot().items.map((item) => item.id)).toEqual([1, 2, 3])
	expect(getSnapshot().hasMore).toBe(false)

	// Nothing more to load: loadMore is a no-op that reports false.
	expect(
		await list.loadMore(async () => ({
			items: [{ id: 4 }],
			hasMore: false,
			totalCount: 4,
		})),
	).toBe(false)
	expect(getSnapshot().items.map((item) => item.id)).toEqual([1, 2, 3])
})

test('reset invalidates an in-flight loadMore so a stale page never lands', async () => {
	const { list, getSnapshot } = createList()
	await list.loadInitial(async () => ({
		items: [{ id: 1 }],
		hasMore: true,
		totalCount: 10,
	}))

	let releaseStaleLoad = () => {}
	const staleGate = new Promise<void>((resolve) => {
		releaseStaleLoad = resolve
	})
	const staleLoadMore = list.loadMore(async () => {
		await staleGate
		return { items: [{ id: 2 }], hasMore: true, totalCount: 10 }
	})

	// Filters changed: the window is re-seeded while the old page is in
	// flight (this is what the admin users page does on every filter edit).
	list.reset()
	list.replaceWindow({
		items: [{ id: 7 }],
		hasMore: true,
		totalCount: 2,
	})
	releaseStaleLoad()

	expect(await staleLoadMore).toBe(false)
	expect(getSnapshot().items.map((item) => item.id)).toEqual([7])
	expect(getSnapshot().totalCount).toBe(2)
})

test('loadMore failures surface an error without dropping loaded items', async () => {
	const { list, getSnapshot } = createList()
	await list.loadInitial(async () => ({
		items: [{ id: 1 }],
		hasMore: true,
		totalCount: 2,
	}))

	const loaded = await list.loadMore(async () => {
		throw new Error('Unable to load more users.')
	})
	expect(loaded).toBe(false)
	expect(getSnapshot().error).toBe('Unable to load more users.')
	expect(getSnapshot().items.map((item) => item.id)).toEqual([1])
	expect(getSnapshot().isLoadingMore).toBe(false)
})
