import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

const sourceSnapshotVersion = 1
const sourceManifestSnapshotVersion = 1
const bundleArtifactVersion = 1
const sourceSnapshotPrefix = 'source-snapshot'
const sourceManifestSnapshotPrefix = 'source-manifest-snapshot'
const bundleArtifactPrefix = 'bundle-artifact'

export type BundleArtifactKind = 'app' | 'job' | 'module' | 'service'

export type BundleArtifactDependency = {
	sourceId: string
	publishedCommit: string
	kodyId: string
	packageName?: string
}

type SerializedWorkerLoaderModule =
	| string
	| {
			js?: string
			cjs?: string
			text?: string
			dataBase64?: string
			json?: object
	  }

export type PublishedSourceSnapshot = {
	version: typeof sourceSnapshotVersion
	sourceId: string
	repoId: string
	entityKind: EntitySourceRow['entity_kind']
	entityId: string
	publishedCommit: string
	manifestPath: string
	sourceRoot: string
	files: Record<string, string>
	createdAt: string
}

export type PublishedSourceManifestSnapshot = {
	version: typeof sourceManifestSnapshotVersion
	sourceId: string
	publishedCommit: string
	manifestPath: string
	manifestContent: string
	createdAt: string
}

export type PublishedBundleArtifact = {
	version: typeof bundleArtifactVersion
	kind: BundleArtifactKind
	artifactName: string | null
	sourceId: string
	publishedCommit: string
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	packageContext: {
		packageId: string
		kodyId: string
	} | null
	serviceContext: {
		serviceName: string
	} | null
	createdAt: string
}

function getBundleArtifactsKv(env: Env) {
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }).BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error(
			'Missing BUNDLE_ARTIFACTS_KV binding for published runtime artifacts.',
		)
	}
	return kv
}

function toBase64(value: ArrayBuffer) {
	const bytes = new Uint8Array(value)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

function fromBase64(value: string) {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes.buffer
}

function serializeWorkerLoaderModules(
	modules: WorkerLoaderModules,
): Record<string, SerializedWorkerLoaderModule> {
	return Object.fromEntries(
		Object.entries(modules).map(([path, module]) => {
			if (typeof module === 'string') {
				return [path, module]
			}
			return [
				path,
				{
					...(module.js !== undefined ? { js: module.js } : {}),
					...(module.cjs !== undefined ? { cjs: module.cjs } : {}),
					...(module.text !== undefined ? { text: module.text } : {}),
					...(module.data !== undefined
						? { dataBase64: toBase64(module.data) }
						: {}),
					...(module.json !== undefined ? { json: module.json } : {}),
				} satisfies SerializedWorkerLoaderModule,
			]
		}),
	)
}

function deserializeWorkerLoaderModules(
	modules: Record<string, SerializedWorkerLoaderModule>,
): WorkerLoaderModules {
	return Object.fromEntries(
		Object.entries(modules).map(([path, module]) => {
			if (typeof module === 'string') {
				return [path, module]
			}
			return [
				path,
				{
					...(module.js !== undefined ? { js: module.js } : {}),
					...(module.cjs !== undefined ? { cjs: module.cjs } : {}),
					...(module.text !== undefined ? { text: module.text } : {}),
					...(module.dataBase64 !== undefined
						? { data: fromBase64(module.dataBase64) }
						: {}),
					...(module.json !== undefined ? { json: module.json } : {}),
				},
			]
		}),
	)
}

function normalizeArtifactName(artifactName: string | null | undefined) {
	return artifactName?.trim() || '_'
}

function normalizeEntryPoint(entryPoint: string) {
	return entryPoint.trim().replace(/^\.?\//, '')
}

export function buildPublishedSourceSnapshotKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${sourceSnapshotPrefix}:v${sourceSnapshotVersion}:${input.sourceId}:${input.publishedCommit}`
}

export function buildPublishedSourceManifestSnapshotKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${sourceManifestSnapshotPrefix}:v${sourceManifestSnapshotVersion}:${input.sourceId}:${input.publishedCommit}`
}

export function buildPublishedBundleArtifactKvKey(input: {
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
}) {
	return [
		bundleArtifactPrefix,
		`v${bundleArtifactVersion}`,
		input.sourceId,
		input.publishedCommit,
		input.kind,
		normalizeArtifactName(input.artifactName),
		normalizeEntryPoint(input.entryPoint),
	].join(':')
}

export function hasPublishedRuntimeArtifacts(env: Env) {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV != null
	)
}

export async function writePublishedSourceSnapshot(input: {
	env: Env
	source: EntitySourceRow
	files: Record<string, string>
}) {
	if (!input.source.published_commit) {
		return null
	}
	const snapshot: PublishedSourceSnapshot = {
		version: sourceSnapshotVersion,
		sourceId: input.source.id,
		repoId: input.source.repo_id,
		entityKind: input.source.entity_kind,
		entityId: input.source.entity_id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		sourceRoot: input.source.source_root,
		files: input.files,
		createdAt: new Date().toISOString(),
	}
	const key = buildPublishedSourceSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	const manifestContent = input.files[input.source.manifest_path]
	if (typeof manifestContent !== 'string') {
		throw new Error(
			`Published source snapshot is missing manifest "${input.source.manifest_path}".`,
		)
	}
	const manifestKey = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	const manifestSnapshot: PublishedSourceManifestSnapshot = {
		version: sourceManifestSnapshotVersion,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		manifestContent,
		createdAt: snapshot.createdAt,
	}
	await Promise.all([
		getBundleArtifactsKv(input.env).put(key, JSON.stringify(snapshot)),
		getBundleArtifactsKv(input.env).put(
			manifestKey,
			JSON.stringify(manifestSnapshot),
		),
	])
	return key
}

export async function readPublishedSourceSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return null
	const key = buildPublishedSourceSnapshotKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})
	const stored = await getBundleArtifactsKv(input.env).get(key, 'json')
	if (!stored || typeof stored !== 'object') return null
	const snapshot = stored as PublishedSourceSnapshot
	if (
		snapshot.version !== sourceSnapshotVersion ||
		snapshot.sourceId !== input.sourceId ||
		snapshot.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return snapshot
}

export async function loadPublishedSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}) {
	void input.userId
	return await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
}

export async function readPublishedSourceManifestSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return null
	const key = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})
	const stored = await getBundleArtifactsKv(input.env).get(key, 'json')
	if (!stored || typeof stored !== 'object') return null
	const snapshot = stored as PublishedSourceManifestSnapshot
	if (
		snapshot.version !== sourceManifestSnapshotVersion ||
		snapshot.sourceId !== input.sourceId ||
		snapshot.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return snapshot
}

export async function loadPublishedSourceManifestSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}) {
	void input.userId
	return await readPublishedSourceManifestSnapshot({
		env: input.env,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
}

export async function persistPublishedSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	snapshot: Pick<PublishedSourceSnapshot, 'files'>
}) {
	void input.userId
	return await writePublishedSourceSnapshot({
		env: input.env,
		source: input.source,
		files: input.snapshot.files,
	})
}

export async function persistPublishedSourceManifestSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	snapshot: Pick<PublishedSourceManifestSnapshot, 'manifestContent'>
}) {
	void input.userId
	if (!input.source.published_commit) return null
	const manifestSnapshot: PublishedSourceManifestSnapshot = {
		version: sourceManifestSnapshotVersion,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		manifestContent: input.snapshot.manifestContent,
		createdAt: new Date().toISOString(),
	}
	const key = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	await getBundleArtifactsKv(input.env).put(key, JSON.stringify(manifestSnapshot))
	return key
}

export async function deletePublishedSourceSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return
	await Promise.all([
		getBundleArtifactsKv(input.env).delete(
			buildPublishedSourceSnapshotKvKey({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
			}),
		),
		getBundleArtifactsKv(input.env).delete(
			buildPublishedSourceManifestSnapshotKvKey({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
			}),
		),
	])
}

export async function writePublishedBundleArtifact(input: {
	env: Env
	artifact: PublishedBundleArtifact
	kvKey?: string
}) {
	const kvKey =
		input.kvKey ??
		buildPublishedBundleArtifactKvKey({
			sourceId: input.artifact.sourceId,
			publishedCommit: input.artifact.publishedCommit,
			kind: input.artifact.kind,
			artifactName: input.artifact.artifactName,
			entryPoint: input.artifact.entryPoint,
		})
	await getBundleArtifactsKv(input.env).put(
		kvKey,
		JSON.stringify({
			...input.artifact,
			modules: serializeWorkerLoaderModules(input.artifact.modules),
		}),
	)
	return kvKey
}

export async function readPublishedBundleArtifact(input: {
	env: Env
	kvKey: string
}) {
	const stored = await getBundleArtifactsKv(input.env).get(input.kvKey, 'json')
	if (!stored || typeof stored !== 'object') return null
	const artifact = stored as Omit<PublishedBundleArtifact, 'modules'> & {
		modules: Record<string, SerializedWorkerLoaderModule>
	}
	if (
		artifact.version !== bundleArtifactVersion ||
		typeof artifact.modules !== 'object' ||
		artifact.modules == null
	) {
		return null
	}
	return {
		...artifact,
		modules: deserializeWorkerLoaderModules(artifact.modules),
	} satisfies PublishedBundleArtifact
}

export async function deletePublishedBundleArtifact(input: {
	env: Env
	kvKey: string
}) {
	await getBundleArtifactsKv(input.env).delete(input.kvKey)
}
