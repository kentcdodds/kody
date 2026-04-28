import * as Sentry from '@sentry/cloudflare'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { loadPublishedBundleArtifactByIdentity } from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	type PackageRetrieverManifestCacheEntry,
	type PackageRetrieverResult,
	type PackageRetrieverScope,
	type PackageRetrieverSurfaceResult,
	packageRetrieverOutputSchema,
} from './types.ts'
import { listPackageRetrieversForScope } from './manifest-cache.ts'

const defaultSearchLimit = 5
const defaultContextLimit = 2
const defaultSearchTimeoutMs = 1_000
const defaultContextTimeoutMs = 300
const maxResultSummaryLength = 1_000
const maxResultDetailsLength = 4_000

function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		sessionRepoId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

function buildPackageRetrieverStorageId(packageId: string) {
	return `package:${encodeURIComponent(packageId)}`
}

function clampLimit(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextLimit : defaultSearchLimit
	const max = scope === 'context' ? defaultContextLimit : defaultSearchLimit
	return Math.min(max, Math.max(1, value ?? fallback))
}

function clampTimeout(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextTimeoutMs : defaultSearchTimeoutMs
	const max =
		scope === 'context' ? defaultContextTimeoutMs : defaultSearchTimeoutMs
	return Math.min(max, Math.max(1, value ?? fallback))
}

function truncate(value: string | undefined, maxLength: number) {
	if (value === undefined) return undefined
	return value.length <= maxLength ? value : value.slice(0, maxLength)
}

function normalizeRetrieverResults(input: {
	entry: PackageRetrieverManifestCacheEntry
	results: Array<PackageRetrieverResult>
}): Array<PackageRetrieverSurfaceResult> {
	return input.results.map((result) => ({
		...result,
		summary: truncate(result.summary, maxResultSummaryLength) ?? '',
		details: truncate(result.details, maxResultDetailsLength),
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		retrieverKey: input.entry.retrieverKey,
		retrieverName: input.entry.name,
	}))
}

async function invokeRetriever(input: {
	env: Env
	baseUrl: string
	userId: string
	scope: PackageRetrieverScope
	entry: PackageRetrieverManifestCacheEntry
	query: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.entry.packageId,
	})
	if (!savedPackage) {
		return []
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.entry.sourceId,
	)
	if (
		!source ||
		(source.published_commit ?? source.indexed_commit ?? source.updated_at) !==
			input.entry.revision
	) {
		return []
	}
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.entry.sourceId,
		kind: 'module',
		artifactName: input.entry.exportName,
		entryPoint: input.entry.entryPoint,
	})
	if (!loaded?.artifact) {
		return []
	}
	const limit = clampLimit(input.entry.maxResults, input.scope)
	const callerContext = createMcpCallerContext({
		baseUrl: input.baseUrl,
		user: {
			userId: input.userId,
			email: '',
			displayName: '',
		},
		storageContext: {
			sessionId: null,
			appId: input.entry.packageId,
			storageId: buildPackageRetrieverStorageId(input.entry.packageId),
		},
		repoContext: createRepoContext(source),
	})
	const executionResult = await runBundledModuleWithRegistry(
		input.env,
		callerContext,
		{
			mainModule: loaded.artifact.mainModule,
			modules: loaded.artifact.modules,
		},
		{
			query: input.query,
			scope: input.scope,
			memoryContext: input.memoryContext ?? null,
			limit,
			conversationId: input.conversationId ?? null,
		},
		{
			storageTools: {
				userId: input.userId,
				storageId: buildPackageRetrieverStorageId(input.entry.packageId),
				writable: false,
			},
			packageContext: {
				packageId: input.entry.packageId,
				kodyId: input.entry.kodyId,
			},
			executorTimeoutMs: clampTimeout(input.entry.timeoutMs, input.scope),
		},
	)
	if (executionResult.error) {
		throw executionResult.error
	}
	const parsed = packageRetrieverOutputSchema.safeParse(executionResult.result)
	if (!parsed.success) {
		throw new Error(
			`Retriever "${input.entry.retrieverKey}" returned an invalid result shape.`,
		)
	}
	return normalizeRetrieverResults({
		entry: input.entry,
		results: parsed.data.results.slice(0, limit),
	})
}

async function loadScopeEntries(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
}) {
	return (await listPackageRetrieversForScope(input))
		.filter((entry) => entry.scopes.includes(input.scope))
		.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.retrieverKey.localeCompare(right.retrieverKey),
		)
}

export async function runPackageRetrievers(input: {
	env: Env
	baseUrl: string
	userId: string | null
	scope: PackageRetrieverScope
	query: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
	maxProviders?: number
}) {
	const userId = input.userId?.trim()
	const query = input.query.trim()
	if (!userId || !query) {
		return {
			results: [],
			warnings: [],
		}
	}
	if (!('BUNDLE_ARTIFACTS_KV' in input.env)) {
		return {
			results: [],
			warnings: [],
		}
	}
	const entries = (
		await loadScopeEntries({
			env: input.env,
			userId,
			scope: input.scope,
		})
	).slice(0, input.maxProviders ?? (input.scope === 'context' ? 3 : 10))
	const settled = await Promise.allSettled(
		entries.map((entry) =>
			invokeRetriever({
				env: input.env,
				baseUrl: input.baseUrl,
				userId,
				scope: input.scope,
				entry,
				query,
				memoryContext: input.memoryContext,
				conversationId: input.conversationId,
			}),
		),
	)
	const results: Array<PackageRetrieverSurfaceResult> = []
	const warnings: Array<string> = []
	for (let index = 0; index < settled.length; index += 1) {
		const outcome = settled[index]
		const entry = entries[index]
		if (!outcome || !entry) continue
		if (outcome.status === 'fulfilled') {
			results.push(...outcome.value)
			continue
		}
		const message =
			outcome.reason instanceof Error
				? outcome.reason.message
				: String(outcome.reason)
		console.error(
			JSON.stringify({
				message: 'package retriever failed',
				packageId: entry.packageId,
				kodyId: entry.kodyId,
				retrieverKey: entry.retrieverKey,
				scope: input.scope,
				error: message,
			}),
		)
		Sentry.captureException(outcome.reason, {
			tags: {
				scope: 'package-retriever',
				retrieverScope: input.scope,
			},
			extra: {
				packageId: entry.packageId,
				kodyId: entry.kodyId,
				retrieverKey: entry.retrieverKey,
			},
		})
		if (input.scope === 'search') {
			warnings.push(
				`Package retriever "${entry.kodyId}/${entry.retrieverKey}" failed: ${message}`,
			)
		}
	}
	return {
		results: results.sort(
			(left, right) => (right.score ?? 0) - (left.score ?? 0),
		),
		warnings,
	}
}
