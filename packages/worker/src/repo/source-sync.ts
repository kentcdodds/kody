import {
	hasArtifactsAccess,
	type ArtifactBootstrapAccess,
	isLoopbackArtifactsRemote,
} from './artifacts.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	createSnapshotFilesWorkspace,
	formatFailedRepoCheckMessages,
	runRepoChecks,
} from './checks.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import {
	buildRepoLargeFileMessage,
	findOversizedRepoSourceFile,
} from './large-file-policy.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { parseRepoManifest } from './manifest.ts'
import {
	loadLockedSavedPackage,
	PackagePublishLockedError,
} from '#worker/package-registry/package-publish-lock.ts'
import { repoSessionRpc } from './repo-session-rpc.ts'
import {
	buildPublishedSourceSnapshotKvKey,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type EntitySourceRow } from './types.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

type SyncArtifactSourceInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string | null
	files: Record<string, string>
	bootstrapAccess?: ArtifactBootstrapAccess | null
	/**
	 * First-publish a storage-layer fork from dest HEAD. Applies `files` on
	 * top of that commit through `bootstrapSource` instead of force-publishing
	 * an already-stamped source (which hits the overwrite confirmation gate).
	 */
	existingHeadCommit?: string
	destructiveOverwriteConfirmed?: boolean
	privateVisibilityChangeConfirmed?: boolean
	/**
	 * When set, package publish validates `package.json#name` against this
	 * scope instead of skipping scope checks. Used for username-rename
	 * rewrites that publish the new scope before `users.username` flips.
	 */
	expectedPackageScope?: string
	/** Optional git commit message used when publishing an existing source. */
	commitMessage?: string
	/** Request-scoped phase timings; omitted when the caller does not collect. */
	serverTiming?: Array<ServerTimingEntry>
	/** Website or platform-owned rewrites may promote a locked package. */
	allowLockedPublish?: boolean
	/**
	 * When false, commit and push HEAD without advancing published_commit.
	 * Used by fleet codemods on locked packages.
	 */
	promotePublished?: boolean
	/**
	 * Forwarded to `runRepoChecks`. Platform codemods pass `false` so legacy
	 * trees without README/AGENTS stay migratable. Omit (default true) for
	 * packageSave and other authoring lanes — same default as
	 * `publishFromExternalRef`.
	 */
	requirePackageDocs?: boolean
	/**
	 * When false, skip the throwing publish-check gate in bootstrap / loopback
	 * / package update sync. Community install persists an inert fork first and
	 * runs its own `runRepoChecks` to choose live vs `adaptation_required`;
	 * failing persist on check failure would break that path. Omit (default
	 * true) for packageSave — same gate strength as `publishFromExternalRef`.
	 */
	runPublishChecks?: boolean
}

function validateEntitySourceManifest(input: {
	entityKind: EntitySourceRow['entity_kind']
	content: string
	manifestPath: string
}) {
	if (input.entityKind === 'package') {
		parseAuthoredPackageJson({
			content: input.content,
			manifestPath: input.manifestPath,
		})
		return
	}
	if (input.entityKind === 'repo') {
		return
	}
	parseRepoManifest({
		content: input.content,
		manifestPath: input.manifestPath,
	})
}

async function assertPackageBootstrapUnlocked(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	allowLockedPublish?: boolean
}): Promise<void> {
	if (input.source.entity_kind !== 'package') return
	if (input.allowLockedPublish === true) return
	const lockedPackage = await loadLockedSavedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.source.entity_id,
	})
	if (!lockedPackage) return
	throw new Error(
		`Package "${lockedPackage.name}" is locked. Unlock it on the website before the first published snapshot can be created.`,
	)
}

function canSyncArtifactSource(env: Env) {
	const runtimeEnv = env as Env & {
		REPO_SESSION?: DurableObjectNamespace | undefined
		APP_DB?: D1Database | undefined
		BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined
	}
	return (
		hasArtifactsAccess(env) &&
		runtimeEnv.REPO_SESSION != null &&
		typeof runtimeEnv.APP_DB?.prepare === 'function' &&
		runtimeEnv.BUNDLE_ARTIFACTS_KV != null
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}-${crypto.randomUUID()}`
}

async function writePublishedSnapshotWithRevert(input: {
	env: Env
	source: EntitySourceRow
	files: Record<string, string>
	publishedCommit: string
}) {
	try {
		await writePublishedSourceSnapshot({
			env: input.env,
			source: {
				...input.source,
				published_commit: input.publishedCommit,
			},
			files: input.files,
		})
	} catch (error) {
		await updateEntitySource(input.env.APP_DB, {
			id: input.source.id,
			userId: input.source.user_id,
			publishedCommit: input.source.published_commit,
			manifestPath: input.source.manifest_path,
			sourceRoot: input.source.source_root,
		})
		throw error
	}
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string | null> {
	if (!input.sourceId || !canSyncArtifactSource(input.env)) {
		return null
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	// Per-user isolation: every caller passes the owning user's id (fleet
	// codemods pass the package owner, not the acting admin). A mismatch means
	// a bug upstream, so fail closed before any repo write.
	if (source.user_id !== input.userId) {
		throw new Error(
			'Entity source ownership mismatch: refusing to sync a repo snapshot for another user.',
		)
	}
	if (source.published_commit && input.existingHeadCommit) {
		throw new Error(
			`Source "${source.id}" already has a published commit; existingHeadCommit is only valid for first publish from a forked dest HEAD.`,
		)
	}
	const sessionId = buildSyncSessionId(source.id)
	const session = repoSessionRpc(input.env, sessionId)
	const edits = Object.entries(input.files).map(([path, content]) => ({
		kind: 'write' as const,
		path,
		content,
	}))
	try {
		if (!source.published_commit) {
			await assertPackageBootstrapUnlocked({
				env: input.env,
				userId: input.userId,
				source,
				allowLockedPublish: input.allowLockedPublish,
			})
			if (
				input.bootstrapAccess?.remote &&
				isLoopbackArtifactsRemote(input.bootstrapAccess.remote) &&
				input.existingHeadCommit == null
			) {
				return await pushServerTiming(
					input.serverTiming,
					'mock-artifact-snapshot',
					async () => {
						// The local-dev mock lane skips the RepoSession applyEdits gate, so
						// enforce the per-file limit here for dev/prod parity.
						const oversizedFile = findOversizedRepoSourceFile(
							Object.entries(input.files),
						)
						if (oversizedFile) {
							throw new Error(buildRepoLargeFileMessage(oversizedFile))
						}
						// Plain repos have no manifest requirement (live-at-HEAD).
						if (source.entity_kind !== 'repo') {
							const manifestContent = input.files[source.manifest_path]
							if (typeof manifestContent !== 'string') {
								throw new Error(
									`Manifest "${source.manifest_path}" was not found in the repo source.`,
								)
							}
							validateEntitySourceManifest({
								entityKind: source.entity_kind,
								content: manifestContent,
								manifestPath: source.manifest_path,
							})
						}
						// Same publish gate as bootstrapSource / publishFromExternalRef:
						// do not stamp published_commit or the published snapshot until
						// runRepoChecks passes on this tree. Community install opts out
						// via runPublishChecks: false (its own checks drive adaptation).
						if (
							source.entity_kind === 'package' &&
							input.runPublishChecks !== false
						) {
							const checks = await runRepoChecks({
								workspace: createSnapshotFilesWorkspace(input.files),
								manifestPath: source.manifest_path,
								sourceRoot: source.source_root || '/',
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								...(input.expectedPackageScope !== undefined
									? { expectedPackageScope: input.expectedPackageScope }
									: {}),
								...(input.requirePackageDocs === false
									? { requirePackageDocs: false }
									: {}),
							})
							if (!checks.ok) {
								throw new Error(formatFailedRepoCheckMessages(checks.results))
							}
						}
						const snapshot = await writeArtifactSourceSnapshot({
							env: input.env,
							repoId: source.repo_id,
							files: input.files,
						})
						await writePublishedSourceSnapshot({
							env: input.env,
							source: {
								...source,
								published_commit: snapshot.published_commit,
							},
							files: input.files,
						})
						try {
							await updateEntitySource(input.env.APP_DB, {
								id: source.id,
								userId: source.user_id,
								publishedCommit: snapshot.published_commit,
								manifestPath: source.manifest_path,
								sourceRoot: source.source_root,
							})
						} catch (error) {
							await input.env.BUNDLE_ARTIFACTS_KV.delete(
								buildPublishedSourceSnapshotKvKey({
									sourceId: source.id,
									publishedCommit: snapshot.published_commit,
								}),
							)
							throw error
						}
						return snapshot.published_commit
					},
				)
			}
			const bootstrapResult = await pushServerTiming(
				input.serverTiming,
				'bootstrap-source',
				async () => {
					const result = await session.bootstrapSource({
						sessionId,
						sourceId: source.id,
						userId: input.userId,
						edits,
						bootstrapAccess: input.bootstrapAccess ?? null,
						...(input.existingHeadCommit
							? { existingHeadCommit: input.existingHeadCommit }
							: {}),
						...(input.requirePackageDocs === false
							? { requirePackageDocs: false }
							: {}),
						...(input.runPublishChecks === false
							? { runPublishChecks: false }
							: {}),
					})
					if (input.serverTiming && result.serverTiming) {
						input.serverTiming.push(...result.serverTiming)
					}
					return result
				},
			)
			const snapshotFiles = bootstrapResult.files ?? input.files
			if (
				input.existingHeadCommit &&
				(bootstrapResult.files == null ||
					Object.keys(bootstrapResult.files).length === 0)
			) {
				throw new Error(
					`Source "${source.id}" first-publish from dest HEAD produced no workspace snapshot.`,
				)
			}
			await pushServerTiming(input.serverTiming, 'published-snapshot', () =>
				writePublishedSnapshotWithRevert({
					env: input.env,
					source,
					files: snapshotFiles,
					publishedCommit: bootstrapResult.publishedCommit,
				}),
			)
			return bootstrapResult.publishedCommit
		}
		await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		await session.applyEdits({
			sessionId,
			userId: input.userId,
			edits,
			dryRun: false,
			rollbackOnError: true,
		})
		// packageSave updates previously used publishSession({ force: true }),
		// which skipped the check-status gate. For packages, run the same
		// runRepoChecks path publishFromExternalRef uses, then publish without
		// force so the session check-status contract still holds. Destructive
		// overwrite still needs force for history rewrite / force-push, but
		// only after checks pass.
		const forcePublish =
			source.entity_kind !== 'package' ||
			input.destructiveOverwriteConfirmed === true
		if (source.entity_kind === 'package' && input.runPublishChecks !== false) {
			const checkRun = await session.runChecks({
				sessionId,
				userId: input.userId,
				...(input.expectedPackageScope !== undefined
					? { expectedPackageScope: input.expectedPackageScope }
					: {}),
				...(input.requirePackageDocs === false
					? { requirePackageDocs: false }
					: {}),
			})
			if (!checkRun.ok) {
				throw new Error(formatFailedRepoCheckMessages(checkRun.results))
			}
		}
		const publishResult = await session.publishSession({
			sessionId,
			userId: input.userId,
			...(forcePublish ? { force: true } : {}),
			...(input.destructiveOverwriteConfirmed === true
				? { destructiveOverwriteConfirmed: true }
				: {}),
			...(input.privateVisibilityChangeConfirmed === true
				? { privateVisibilityChangeConfirmed: true }
				: {}),
			...(input.expectedPackageScope !== undefined
				? { expectedPackageScope: input.expectedPackageScope }
				: {}),
			...(input.commitMessage !== undefined
				? { commitMessage: input.commitMessage }
				: {}),
			...(input.allowLockedPublish === true
				? { allowLockedPublish: true }
				: {}),
			...(input.promotePublished === false ? { promotePublished: false } : {}),
		})
		if (publishResult.status === 'locked') {
			throw new PackagePublishLockedError({
				packageId: publishResult.packageId,
				packageName: publishResult.packageName,
				pendingCommit: publishResult.pendingCommit,
				currentPublishedCommit: publishResult.currentPublishedCommit,
			})
		}
		if (publishResult.status !== 'ok') {
			throw new Error(publishResult.message)
		}
		// publishSession persists the workspace snapshot to
		// BUNDLE_ARTIFACTS_KV and reverts entity_sources.published_commit
		// itself if that KV write fails, so a second
		// writePublishedSnapshotWithRevert here would be redundant on
		// success and actively harmful on failure: its revert would undo
		// the consistent D1+KV state that publishSession already
		// established, while leaving the repo session row marked
		// status: 'published' with the new base_commit. See
		// repo-session-do.ts publishSession for the internal snapshot
		// persistence and rollback.
		return publishResult.publishedCommit
	} finally {
		await pushServerTiming(input.serverTiming, 'discard-session', () =>
			session.discardSession({ sessionId, userId: input.userId }).catch(() => {
				// Best effort only; publish/apply failures should preserve the root cause.
			}),
		)
	}
}
