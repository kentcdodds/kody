import { toJobView } from '@kody-internal/shared/jobs/schedule.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidateCommunityPublicCache } from '#worker/app/data-cache.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import { deleteEntitySourceWithArtifacts } from '#worker/jobs/service.ts'
import { mcpClientHubTransferStub } from '#worker/mcp-client/hub-transfer.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'
import { refreshPackageSubscriptionTopicMap } from '#worker/package-invocations/subscription-topic-cache.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { scheduleSavedPackageSearchIndexUpsert } from '#worker/package-registry/search-index-debt.ts'
import { deleteAllPackageSkillsIndexEntriesForUser } from '#worker/package-registry/skills-index-cache.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { deleteSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import {
	deleteAllPackageRetrieverCacheEntriesForUser,
	refreshPackageRetrieverManifestCache,
} from '#worker/package-retrievers/manifest-cache.ts'
import { deleteRepoSessionsBySourceForUser } from '#worker/repo/repo-sessions.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { deleteStorageBucketInventory } from '#worker/storage-buckets/service.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { buildMemoryEmbedTextFromRow } from '#mcp/memory/memory-embed.ts'
import {
	deleteMemoryVector,
	upsertMemoryVector,
} from '#mcp/memory/memory-vectorize.ts'
import { type McpMemoryRow } from '#mcp/memory/types.ts'
import { countOrgTransferLeftovers } from './batch.ts'
import { type OrgTransferPlan } from './plan.ts'
import { clearOwnerStorage } from './storage-copy.ts'

/**
 * Cleanup and reindex after the batch commits. The move itself is already
 * durable, so each step is best-effort: a failure becomes a warning naming
 * the step, never a rollback.
 */
export async function runOrgTransferPostCommit(input: {
	env: Env
	baseUrl: string
	plan: OrgTransferPlan
	cleanupOrphans: boolean
}) {
	const { env, plan } = input
	const fromId = plan.from.id
	const toId = plan.to.id
	const warnings: Array<string> = []
	const step = async (label: string, run: () => Promise<unknown>) => {
		try {
			await run()
		} catch (error) {
			warnings.push(
				`${label}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	let leftovers: Record<string, number> = {}
	await step('leftover check', async () => {
		leftovers = await countOrgTransferLeftovers({ db: env.APP_DB, plan })
	})

	for (const copy of plan.storageCopies) {
		await step(`clear source storage ${copy.storageId}`, () =>
			clearOwnerStorage({ env, userId: fromId, storageId: copy.storageId }),
		)
	}
	const sourceHub = mcpClientHubTransferStub({ env, userId: fromId })
	const targetHub = mcpClientHubTransferStub({ env, userId: toId })
	// Close the source connection before dialing the target, so only one hub
	// can refresh (and rotate) the server's OAuth tokens.
	for (const row of plan.moves.mcp_server_settings) {
		await step(`remove source MCP server ${String(row['name'])}`, () =>
			sourceHub.removeServer({ serverId: String(row['id']) }),
		)
		await step(`connect MCP server ${String(row['name'])}`, () =>
			targetHub.connectTransferredServer({ serverId: String(row['id']) }),
		)
	}
	for (const copy of plan.logoCopies) {
		await step(`delete source logo ${copy.fromKey}`, () =>
			env.COMMUNITY_ASSETS.delete(copy.fromKey),
		)
	}
	if (input.cleanupOrphans) {
		for (const orphan of plan.orphans) {
			switch (orphan.cleanup) {
				case 'entity-source':
					await step(`delete orphan source ${orphan.key}`, () =>
						deleteEntitySourceWithArtifacts({
							env,
							userId: fromId,
							source: orphan.row as unknown as EntitySourceRow,
						}),
					)
					break
				case 'storage-bucket':
					await step(`delete orphan storage ${orphan.key}`, async () => {
						await clearOwnerStorage({
							env,
							userId: fromId,
							storageId: orphan.key,
						})
						await deleteStorageBucketInventory({
							db: env.APP_DB,
							userId: fromId,
							storageId: orphan.key,
						})
					})
					break
				// Already handled in the batch.
				case 'soft-delete':
				case 'delete':
					break
				default: {
					const exhaustive: never = orphan.cleanup
					throw new Error(`Unknown orphan cleanup: ${String(exhaustive)}`)
				}
			}
		}
	}
	for (const source of plan.moves.entity_sources) {
		await step(`discard repo sessions of source ${String(source['id'])}`, () =>
			deleteRepoSessionsBySourceForUser(env, {
				userId: fromId,
				sourceId: String(source['id']),
			}),
		)
	}

	for (const row of plan.moves.saved_packages) {
		const packageId = String(row['id'])
		const sourceId = String(row['source_id'])
		await step(`reindex package ${String(row['kody_id'])}`, async () => {
			await deleteSavedPackageVector(env, packageId)
			const loaded = await loadPackageManifestBySourceId({
				env,
				baseUrl: input.baseUrl,
				userId: toId,
				sourceId,
			})
			await scheduleSavedPackageSearchIndexUpsert({
				env,
				packageId,
				userId: toId,
				embedText: buildSavedPackageEmbedText(loaded.manifest),
			})
			const savedPackage = await getSavedPackageById(env.APP_DB, {
				userId: toId,
				packageId,
			})
			if (savedPackage && loaded.source.published_commit) {
				await refreshPackageRetrieverManifestCache({
					env,
					userId: toId,
					source: loaded.source,
					savedPackage,
					manifest: loaded.manifest,
				})
			}
		})
		invalidateInvokeContractFreshness({
			userId: fromId,
			packageIdOrKodyIds: [
				packageId,
				String(row['kody_id']),
				`kody:${String(row['name'])}`,
			],
			packageAppSlugs: [String(row['kody_id'])],
			sourceId,
		})
	}
	for (const row of plan.moves.mcp_memories) {
		const memory = row as unknown as McpMemoryRow
		await step(`reindex memory ${memory.id}`, async () => {
			await deleteMemoryVector(env, memory.id)
			await upsertMemoryVector(env, {
				memoryId: memory.id,
				userId: toId,
				category: memory.category,
				status: memory.status,
				embedText: buildMemoryEmbedTextFromRow(memory),
			})
		})
	}
	for (const job of plan.jobs) {
		await step(`reindex job ${job.record.name}`, async () => {
			const view = toJobView(job.record)
			await deleteJobVector(env, job.id)
			await upsertJobVector(env, {
				jobId: job.id,
				userId: toId,
				embedText: buildJobEmbedText({
					name: view.name,
					scheduleSummary: view.scheduleSummary,
					sourceId: view.sourceId,
					publishedCommit: view.publishedCommit,
				}),
			})
		})
	}

	await step('clear source retriever cache', () =>
		deleteAllPackageRetrieverCacheEntriesForUser({ env, userId: fromId }),
	)
	await step('clear source skills index', () =>
		deleteAllPackageSkillsIndexEntriesForUser({ env, userId: fromId }),
	)
	for (const ownerId of [fromId, toId] satisfies Array<OwnerId>) {
		await step(`refresh subscription topics for ${ownerId}`, () =>
			refreshPackageSubscriptionTopicMap({
				env,
				baseUrl: input.baseUrl,
				userId: ownerId,
			}),
		)
		await step(`sync job alarm for ${ownerId}`, () =>
			syncJobManagerAlarm({ env, userId: ownerId }),
		)
	}
	invalidateCommunityPublicCache()
	return { leftovers, warnings }
}
