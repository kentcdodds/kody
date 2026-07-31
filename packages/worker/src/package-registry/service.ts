import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import * as Sentry from '@sentry/cloudflare'
import { buildSavedPackageEmbedText } from './embed.ts'
import { buildPackageSearchProjection } from './manifest.ts'
import {
	deleteSavedPackage,
	getSavedPackageById,
	insertSavedPackage,
	updateSavedPackage,
} from './repo.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
} from './source.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
	type SavedPackageRow,
} from './types.ts'
import {
	deleteSavedPackageVector,
	upsertSavedPackageVector,
} from './vectorize.ts'
import { deleteJobRow, listJobRowsByUserId } from '#worker/jobs/repo.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import { rebuildPublishedPackageArtifacts } from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	buildPackageServiceStorageId,
	listSavedPackageServices,
	packageServiceRpc,
} from '#worker/package-runtime/package-service.ts'
import {
	refreshPackageRetrieverManifestCache,
	removePackageRetrieverManifestCacheEntries,
} from '#worker/package-retrievers/manifest-cache.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'
import { cleanupArtifactReposForPackage } from '#worker/repo/artifact-repo-cleanup.ts'
import { deleteEntitySource } from '#worker/repo/entity-sources.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import {
	deleteAllPackageScopedSecrets,
	removeAllSecretApprovalsForPackage,
	deleteAllAppScopedValues,
} from '#worker/package-config-cleanup.ts'
import { listUserStorageBucketIds } from '#worker/storage-buckets/service.ts'
import {
	buildPackageStorageId,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'

const savedPackageIdUuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function logPackageRetrieverProjectionError(input: {
	action: 'refresh' | 'delete'
	packageId: string
	error: unknown
}) {
	console.error(
		JSON.stringify({
			message: 'package retriever projection update failed',
			action: input.action,
			packageId: input.packageId,
		}),
	)
	Sentry.captureException(input.error, {
		tags: {
			scope: 'package-retriever-projection',
			action: input.action,
		},
		extra: {
			packageId: input.packageId,
		},
	})
}

function serializeTags(tags: Array<string>) {
	return JSON.stringify(tags)
}

/**
 * Inventory prefix matching is UUID-gated on purpose. `package_save` accepts
 * arbitrary non-empty package ids, so a raw prefix like `{packageId}:` can
 * collide with reserved storage namespaces (`job:`, `exec:`, …) or carry LIKE
 * metacharacters (`%`, `_`; `encodeURIComponent` can also introduce `%`). A
 * UUID cannot contain `:` or those metacharacters and cannot equal the reserved
 * namespace literals, which makes `{uuid}:…`, `service:{encodeURIComponent(uuid)}:…`,
 * and `job:package-job:{uuid}:…` unambiguous. Non-UUID packages still clear the
 * deterministic set (package bucket, raw id, job/service scratch ids from D1 /
 * listed services); an orphaned facet bucket for a weird id stays inventoriable
 * for account deletion.
 */
export function filterPackageOwnedStorageIdsFromInventory(input: {
	packageId: string
	storageIds: ReadonlyArray<string>
}): Array<string> {
	const packageStorageId = buildPackageStorageId(input.packageId)
	const matched = new Set<string>()
	for (const storageId of input.storageIds) {
		if (storageId === input.packageId || storageId === packageStorageId) {
			matched.add(storageId)
		}
	}
	if (!savedPackageIdUuidPattern.test(input.packageId)) {
		return [...matched]
	}
	const facetPrefix = `${input.packageId}:`
	const servicePrefix = `service:${encodeURIComponent(input.packageId)}:`
	const jobPrefix = `job:package-job:${input.packageId}:`
	for (const storageId of input.storageIds) {
		if (
			storageId.startsWith(facetPrefix) ||
			storageId.startsWith(servicePrefix) ||
			storageId.startsWith(jobPrefix)
		) {
			matched.add(storageId)
		}
	}
	return [...matched]
}

async function listPackageOwnedStorageIdsFromInventory(input: {
	env: Env
	userId: string
	packageId: string
}): Promise<Array<string>> {
	const storageIds = await listUserStorageBucketIds({
		env: input.env,
		userId: input.userId,
	})
	return filterPackageOwnedStorageIdsFromInventory({
		packageId: input.packageId,
		storageIds,
	})
}

export async function clearPackageOwnedStorageBucket(input: {
	env: Env
	userId: string
	packageId: string
	storageId: string
}): Promise<boolean> {
	let storageCleared = false
	try {
		await storageRunnerRpc({
			env: input.env,
			userId: input.userId,
			storageId: input.storageId,
		}).clearStorage()
		storageCleared = true
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'package storage clear failed',
				userId: input.userId,
				packageId: input.packageId,
				storageId: input.storageId,
				error: getErrorMessage(error),
			}),
		)
	}
	if (!storageCleared) return false
	try {
		await input.env.APP_DB.prepare(
			`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?`,
		)
			.bind(input.userId, input.storageId)
			.run()
		return true
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'package storage bucket unregister failed',
				userId: input.userId,
				packageId: input.packageId,
				storageId: input.storageId,
				error: getErrorMessage(error),
			}),
		)
		return false
	}
}

function toSavedPackageInsertRow(input: {
	packageId: string
	userId: string
	sourceId: string
	manifest: AuthoredPackageJson
}): Omit<SavedPackageRow, 'created_at' | 'updated_at'> {
	const projection = buildPackageSearchProjection(input.manifest)
	return {
		id: input.packageId,
		user_id: input.userId,
		name: projection.name,
		kody_id: projection.kodyId,
		description: projection.description,
		tags_json: serializeTags(projection.tags),
		search_text: projection.searchText,
		source_id: input.sourceId,
		has_app: projection.hasApp ? 1 : 0,
		hidden: 0,
		is_private: projection.isPrivate ? 1 : 0,
	}
}

export async function refreshSavedPackageProjection(input: {
	env: Env
	baseUrl: string
	userId: string
	userEmail?: string | null
	packageId: string
	sourceId: string
	rebuildArtifacts?: boolean
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const shouldRebuildArtifacts = input.rebuildArtifacts ?? true
			const loaded = shouldRebuildArtifacts
				? await loadPackageSourceBySourceId({
						env: input.env,
						baseUrl: input.baseUrl,
						userId: input.userId,
						sourceId: input.sourceId,
					})
				: await loadPackageManifestBySourceId({
						env: input.env,
						baseUrl: input.baseUrl,
						userId: input.userId,
						sourceId: input.sourceId,
					})
			const row = toSavedPackageInsertRow({
				packageId: input.packageId,
				userId: input.userId,
				sourceId: input.sourceId,
				manifest: loaded.manifest,
			})
			const existing = await getSavedPackageById(input.env.APP_DB, {
				userId: input.userId,
				packageId: input.packageId,
			})
			await assertWithinStorageBytesEntitlement({
				db: input.env.APP_DB,
				userId: input.userId,
				email: input.userEmail,
				requested: estimateEntitlementStorageEntryByteDelta({
					next: {
						key: row.id,
						value: {
							name: row.name,
							kodyId: row.kody_id,
							description: row.description,
							tagsJson: row.tags_json,
							searchText: row.search_text,
							sourceId: row.source_id,
						},
					},
					existing: existing
						? {
								key: existing.id,
								value: {
									name: existing.name,
									kodyId: existing.kodyId,
									description: existing.description,
									tagsJson: JSON.stringify(existing.tags),
									searchText: existing.searchText,
									sourceId: existing.sourceId,
								},
							}
						: null,
				}),
			})
			if (existing) {
				await updateSavedPackage(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
					name: row.name,
					kodyId: row.kody_id,
					description: row.description,
					tagsJson: row.tags_json,
					searchText: row.search_text,
					sourceId: row.source_id,
					hasApp: row.has_app === 1,
					isPrivate: row.is_private === 1,
				})
			} else {
				await assertWithinEntitlement({
					db: input.env.APP_DB,
					userId: input.userId,
					email: input.userEmail,
					resource: 'saved_packages',
				})
				await insertSavedPackage(input.env.APP_DB, row)
			}
			await upsertSavedPackageVector(input.env, {
				packageId: input.packageId,
				userId: input.userId,
				embedText: buildSavedPackageEmbedText(loaded.manifest),
			})
			const refreshedAt = new Date().toISOString()
			const savedPackage = {
				id: input.packageId,
				userId: input.userId,
				name: row.name,
				kodyId: row.kody_id,
				description: row.description,
				tags: parseTagsJson(row.tags_json),
				searchText: row.search_text ?? null,
				sourceId: row.source_id,
				hasApp: row.has_app === 1,
				// Preserve visibility across projection refresh / re-save.
				hidden: existing?.hidden ?? false,
				// Privacy is recomputed from the manifest on every refresh.
				isPrivate: row.is_private === 1,
				createdAt: existing?.createdAt ?? refreshedAt,
				updatedAt: refreshedAt,
			} satisfies SavedPackageRecord
			const loadedFiles: Record<string, string> | null =
				shouldRebuildArtifacts && 'files' in loaded
					? (loaded.files as Record<string, string>)
					: null
			if (loadedFiles) {
				await rebuildPublishedPackageArtifacts({
					env: input.env,
					userId: input.userId,
					source: loaded.source,
					savedPackage,
					manifest: loaded.manifest,
					buildAppBundle: async ({ entryPoint }) => {
						const { buildKodyAppBundle } =
							await import('#worker/package-runtime/module-graph.ts')
						return await buildKodyAppBundle({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.userId,
							sourceFiles: loadedFiles,
							entryPoint,
							rootPackageId: savedPackage.id,
							cacheKey: null,
						})
					},
					buildModuleBundle: async ({ entryPoint }) => {
						const { buildKodyModuleBundle } =
							await import('#worker/package-runtime/module-graph.ts')
						return await buildKodyModuleBundle({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.userId,
							sourceFiles: loadedFiles,
							entryPoint,
							rootPackageId: savedPackage.id,
						})
					},
					buildImportableModuleBundle: async ({ entryPoint }) => {
						const { buildKodyImportableModuleBundle } =
							await import('#worker/package-runtime/module-graph.ts')
						return await buildKodyImportableModuleBundle({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.userId,
							sourceFiles: loadedFiles,
							entryPoint,
							rootPackageId: savedPackage.id,
						})
					},
				})
			}
			try {
				await refreshPackageRetrieverManifestCache({
					env: input.env,
					userId: input.userId,
					source: loaded.source,
					savedPackage,
					manifest: loaded.manifest,
				})
			} catch (error) {
				logPackageRetrieverProjectionError({
					action: 'refresh',
					packageId: input.packageId,
					error,
				})
			}
			const { syncPackageJobsForPackage } =
				await import('#worker/jobs/service.ts')
			const schedulerStateChanged = await syncPackageJobsForPackage({
				env: input.env,
				userId: input.userId,
				baseUrl: input.baseUrl,
				packageId: input.packageId,
				sourceId: input.sourceId,
				manifest: loaded.manifest,
			})
			for (const service of loaded.manifest.kody.services
				? Object.keys(loaded.manifest.kody.services)
				: []) {
				const definition = loaded.manifest.kody.services?.[service]
				if (!definition?.autoStart) continue
				try {
					await packageServiceRpc({
						env: input.env,
						userId: input.userId,
						packageId: input.packageId,
						kodyId: row.kody_id,
						sourceId: row.source_id,
						baseUrl: input.baseUrl,
						serviceName: service,
					}).start()
				} catch {
					// Auto-start failures should not block package job sync/alarm refresh.
				}
			}
			if (schedulerStateChanged) {
				await syncJobManagerAlarm({
					env: input.env,
					userId: input.userId,
				})
			}
			// Same-isolate invoke paths must observe this refresh immediately;
			// other isolates converge within the freshness-cache TTL.
			invalidateInvokeContractFreshness({
				userId: input.userId,
				packageIdOrKodyIds: [
					input.packageId,
					row.kody_id,
					...(existing && existing.kodyId !== row.kody_id
						? [existing.kodyId]
						: []),
				],
				sourceId: input.sourceId,
			})
			return {
				record: savedPackage,
				manifest: loaded.manifest,
				...(loadedFiles ? { files: loadedFiles } : {}),
			}
		},
	})
}

export async function deleteSavedPackageProjection(input: {
	env: Env
	userId: string
	packageId: string
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const savedPackage = await getSavedPackageById(input.env.APP_DB, {
				userId: input.userId,
				packageId: input.packageId,
			})
			const packageOwnedStorageIds = new Set<string>([
				buildPackageStorageId(input.packageId),
				input.packageId,
			])
			let packageJobsRemoved = false
			if (savedPackage) {
				const listedServices = await listSavedPackageServices({
					env: input.env,
					userId: input.userId,
					baseUrl: 'https://package-service.invalid',
					packageId: input.packageId,
					savedPackage,
				})
				for (const service of listedServices.services) {
					await packageServiceRpc({
						env: input.env,
						userId: input.userId,
						packageId: savedPackage.id,
						kodyId: savedPackage.kodyId,
						sourceId: savedPackage.sourceId,
						baseUrl: 'https://package-service.invalid',
						serviceName: service.name,
					}).stop()
					packageOwnedStorageIds.add(
						buildPackageServiceStorageId(input.packageId, service.name),
					)
				}
				await cleanupArtifactReposForPackage({
					env: input.env,
					userId: input.userId,
					sourceId: savedPackage.sourceId,
				}).catch((error) => {
					console.warn(
						JSON.stringify({
							message: 'package artifact repo cleanup failed',
							userId: input.userId,
							packageId: input.packageId,
							sourceId: savedPackage.sourceId,
							error: getErrorMessage(error),
						}),
					)
				})
				await deleteEntitySource(input.env.APP_DB, {
					id: savedPackage.sourceId,
					userId: input.userId,
				}).catch((error) => {
					console.warn(
						JSON.stringify({
							message: 'package entity source cleanup failed',
							userId: input.userId,
							packageId: input.packageId,
							sourceId: savedPackage.sourceId,
							error: getErrorMessage(error),
						}),
					)
				})
				const existingRows = await listJobRowsByUserId(
					input.env.APP_DB,
					input.userId,
				)
				const packageRows = existingRows.filter(
					(row) => row.source_id === savedPackage.sourceId,
				)
				for (const row of packageRows) {
					if (row.storage_id) {
						packageOwnedStorageIds.add(row.storage_id)
					}
					await deleteJobRow(input.env.APP_DB, input.userId, row.id)
				}
				packageJobsRemoved = packageRows.length > 0
			}
			try {
				const inventoryIds = await listPackageOwnedStorageIdsFromInventory({
					env: input.env,
					userId: input.userId,
					packageId: input.packageId,
				})
				for (const storageId of inventoryIds) {
					packageOwnedStorageIds.add(storageId)
				}
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'package storage inventory lookup failed',
						userId: input.userId,
						packageId: input.packageId,
						error: getErrorMessage(error),
					}),
				)
			}
			for (const storageId of packageOwnedStorageIds) {
				await clearPackageOwnedStorageBucket({
					env: input.env,
					userId: input.userId,
					packageId: input.packageId,
					storageId,
				})
			}
			await deleteAllPackageScopedSecrets({
				env: input.env,
				userId: input.userId,
				packageId: input.packageId,
			})
			await removeAllSecretApprovalsForPackage({
				env: input.env,
				userId: input.userId,
				packageId: input.packageId,
			})
			await deleteAllAppScopedValues({
				env: input.env,
				userId: input.userId,
				appId: input.packageId,
			}).catch((error) => {
				console.warn(
					JSON.stringify({
						message: 'package app-scoped values cleanup failed',
						userId: input.userId,
						packageId: input.packageId,
						error: getErrorMessage(error),
					}),
				)
			})
			await deleteSavedPackage(input.env.APP_DB, {
				userId: input.userId,
				packageId: input.packageId,
			})
			try {
				await removePackageRetrieverManifestCacheEntries({
					env: input.env,
					userId: input.userId,
					packageId: input.packageId,
				})
			} catch (error) {
				logPackageRetrieverProjectionError({
					action: 'delete',
					packageId: input.packageId,
					error,
				})
			}
			await deleteSavedPackageVector(input.env, input.packageId)
			invalidateInvokeContractFreshness({
				userId: input.userId,
				packageIdOrKodyIds: [
					input.packageId,
					...(savedPackage ? [savedPackage.kodyId] : []),
				],
				sourceId: savedPackage?.sourceId ?? null,
			})
			if (packageJobsRemoved) {
				await syncJobManagerAlarm({
					env: input.env,
					userId: input.userId,
				})
			}
		},
	})
}
