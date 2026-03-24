export type InfiniteListWindow<T> = {
	items: Array<T>
	hasMore: boolean
	totalCount: number
}

export type InfiniteListSnapshot<T> = InfiniteListWindow<T> & {
	error: string | null
	isLoadingInitial: boolean
	isLoadingMore: boolean
}

export type InfiniteListLoadResult<T> = InfiniteListWindow<T>

type InfiniteListOptions<T> = {
	mergeDirection: 'append' | 'prepend'
	getKey: (item: T) => string
	onSnapshot: (snapshot: InfiniteListSnapshot<T>) => void
}

function dedupeByKey<T>(
	items: Array<T>,
	getKey: InfiniteListOptions<T>['getKey'],
) {
	const seenKeys = new Set<string>()
	return items.filter((item) => {
		const key = getKey(item)
		if (seenKeys.has(key)) return false
		seenKeys.add(key)
		return true
	})
}

export function createInfiniteList<T>(options: InfiniteListOptions<T>) {
	let items: Array<T> = []
	let hasMore = false
	let totalCount = 0
	let error: string | null = null
	let isLoadingInitial = false
	let isLoadingMore = false
	let loadVersion = 0

	function getSnapshot(): InfiniteListSnapshot<T> {
		return {
			items,
			hasMore,
			totalCount,
			error,
			isLoadingInitial,
			isLoadingMore,
		}
	}

	function emitSnapshot() {
		options.onSnapshot({
			...getSnapshot(),
			items: [...items],
		})
	}

	function replaceWindow(window: InfiniteListWindow<T>) {
		items = dedupeByKey(window.items, options.getKey)
		hasMore = window.hasMore
		totalCount = window.totalCount
		error = null
		emitSnapshot()
	}

	async function runLoad(
		mode: 'initial' | 'more',
		loader: (input: {
			signal?: AbortSignal
		}) => Promise<InfiniteListLoadResult<T>>,
		signal?: AbortSignal,
	) {
		if (mode === 'initial') {
			if (isLoadingInitial) return false
			isLoadingInitial = true
			error = null
			emitSnapshot()
		} else {
			if (isLoadingInitial || isLoadingMore || !hasMore) return false
			isLoadingMore = true
			error = null
			emitSnapshot()
		}

		const currentLoadVersion = ++loadVersion
		try {
			const window = await loader({ signal })
			if (signal?.aborted || currentLoadVersion !== loadVersion) return false

			if (mode === 'initial') {
				items = dedupeByKey(window.items, options.getKey)
			} else {
				const mergedItems =
					options.mergeDirection === 'prepend'
						? [...window.items, ...items]
						: [...items, ...window.items]
				items = dedupeByKey(mergedItems, options.getKey)
			}
			hasMore = window.hasMore
			totalCount = window.totalCount
			error = null
			return true
		} catch (loadError) {
			if (!signal?.aborted && currentLoadVersion === loadVersion) {
				error =
					loadError instanceof Error
						? loadError.message
						: 'Unable to load more items.'
			}
			return false
		} finally {
			if (currentLoadVersion === loadVersion) {
				if (mode === 'initial') {
					isLoadingInitial = false
				} else {
					isLoadingMore = false
				}
				emitSnapshot()
			}
		}
	}

	return {
		getSnapshot,
		reset() {
			loadVersion += 1
			items = []
			hasMore = false
			totalCount = 0
			error = null
			isLoadingInitial = false
			isLoadingMore = false
			emitSnapshot()
		},
		replaceWindow,
		updateItems(updater: (currentItems: Array<T>) => Array<T>) {
			items = dedupeByKey(updater([...items]), options.getKey)
			emitSnapshot()
		},
		async loadInitial(
			loader: (input: {
				signal?: AbortSignal
			}) => Promise<InfiniteListLoadResult<T>>,
			signal?: AbortSignal,
		) {
			return runLoad('initial', loader, signal)
		},
		async loadMore(
			loader: (input: {
				signal?: AbortSignal
			}) => Promise<InfiniteListLoadResult<T>>,
			signal?: AbortSignal,
		) {
			return runLoad('more', loader, signal)
		},
	}
}
