import { z } from 'zod'
import { packageRetrieverScopeValues } from '#worker/package-registry/types.ts'

export const retrieverScopeSchema = z.enum(packageRetrieverScopeValues)

export type PackageRetrieverScope = z.infer<typeof retrieverScopeSchema>

export type PackageRetrieverManifestCacheEntry = {
	userId: string
	packageId: string
	kodyId: string
	packageName: string
	sourceId: string
	revision: string
	retrieverKey: string
	exportName: string
	entryPoint: string
	name: string
	description: string
	scopes: Array<PackageRetrieverScope>
	timeoutMs: number | null
	maxResults: number | null
}

export type PackageRetrieverManifestCache = {
	version: 1
	userId: string
	packageId: string
	kodyId: string
	packageName: string
	sourceId: string
	revision: string
	manifestHash: string
	retrievers: Array<PackageRetrieverManifestCacheEntry>
	cachedAt: string
}

export type PackageRetrieverIndexEntry = {
	userId: string
	packageId: string
	kodyId: string
	packageName: string
	sourceId: string
	revision: string
	retrieverKey: string
	name: string
	description: string
	scopes: Array<PackageRetrieverScope>
}

export type PackageRetrieverScopeIndex = {
	version: 1
	userId: string
	scope: PackageRetrieverScope
	retrievers: Array<PackageRetrieverIndexEntry>
	updatedAt: string
}

export type PackageRetrieverResult = {
	id: string
	title: string
	summary: string
	details?: string
	score?: number
	source?: string
	url?: string
	metadata?: Record<string, unknown>
}

export type PackageRetrieverSurfaceResult = PackageRetrieverResult & {
	packageId: string
	kodyId: string
	retrieverKey: string
	retrieverName: string
}

export const packageRetrieverResultSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	summary: z.string().min(1),
	details: z.string().min(1).optional(),
	score: z.number().finite().optional(),
	source: z.string().min(1).optional(),
	url: z.string().url().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
})

export const packageRetrieverOutputSchema = z.object({
	results: z.array(packageRetrieverResultSchema).max(20),
})

export type PackageRetrieverOutput = z.infer<
	typeof packageRetrieverOutputSchema
>
