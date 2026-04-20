type PublishedPackageCacheSource = {
	id: string
	published_commit: string | null
	manifest_path: string
	source_root: string
}

export const publishedPackageCacheLimit = 50
export const publishedPackageCacheTtlMs = 5 * 60 * 1000

export function createPublishedPackageCacheKey(input: {
	userId: string
	source: PublishedPackageCacheSource
	entryPoint?: string | null
}) {
	if (!input.source.published_commit) {
		return null
	}

	return JSON.stringify([
		input.userId,
		input.source.id,
		input.source.published_commit,
		input.source.manifest_path,
		input.source.source_root,
		input.entryPoint?.trim() || null,
	])
}

export class PromiseLruCache<T> {
	private readonly cache = new Map<
		string,
		{
			expiresAt: number
			pending: Promise<T>
		}
	>()

	constructor(input?: {
		ttlMs?: number
		limit?: number
	}) {
		this.ttlMs = input?.ttlMs ?? publishedPackageCacheTtlMs
		this.limit = input?.limit ?? publishedPackageCacheLimit
	}

	private readonly ttlMs: number
	private readonly limit: number

	get(key: string) {
		const cached = this.cache.get(key)
		if (!cached) {
			return null
		}
		if (cached.expiresAt <= Date.now()) {
			this.cache.delete(key)
			return null
		}
		this.cache.delete(key)
		this.cache.set(key, cached)
		return cached.pending
	}

	set(key: string, pending: Promise<T>) {
		this.cache.set(key, {
			expiresAt: Date.now() + this.ttlMs,
			pending,
		})
		this.enforceLimit()
		return pending
	}

	getOrCreate(input: {
		cacheKey: string
		create: () => Promise<T>
	}) {
		const cached = this.get(input.cacheKey)
		if (cached) {
			return cached
		}
		const pending = input.create().catch((error) => {
			this.delete(input.cacheKey)
			throw error
		})
		this.set(input.cacheKey, pending)
		return pending
	}

	delete(key: string) {
		this.cache.delete(key)
	}

	private enforceLimit() {
		while (this.cache.size > this.limit) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey === undefined) {
				break
			}
			this.cache.delete(oldestKey)
		}
	}
}

export function createPublishedPackagePromiseCache<T>() {
	return new PromiseLruCache<T>()
}
