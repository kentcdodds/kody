export type NxCacheEnv = {
	CACHE_BUCKET: R2Bucket
	CACHE_ACCESS_TOKEN?: string
	BUILD_COMMIT?: string
}

export type NxCacheObject = {
	body: ReadableStream | ArrayBuffer
	size: number
}

export type NxCacheStore = {
	get(hash: string): Promise<NxCacheObject | null>
	putIfAbsent(
		hash: string,
		body: ReadableStream | ArrayBuffer,
	): Promise<'created' | 'exists'>
}
