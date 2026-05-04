import {
	listEntitySourcesForExternalReconcile,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { revokeStaleArtifactsTokens } from '#worker/repo/artifacts-tokens.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

export type ReconcileArtifactsPushesResult = {
	checked: number
	published: number
	alreadyPublished: number
	checksFailed: number
	notFastForward: number
	errors: number
	tokensRevoked: number
}

const defaultBatchSize = 50
const defaultStaleAfterMinutes = 5

function minutesAgoIso(now: Date, minutes: number) {
	return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function shouldRunDailyTokenCleanup(now: Date) {
	return now.getUTCHours() === 3 && now.getUTCMinutes() < 5
}

export async function reconcileArtifactsPushes(input: {
	env: Env
	baseUrl: string
	batchSize?: number
	staleAfterMinutes?: number
	now?: Date
}): Promise<ReconcileArtifactsPushesResult> {
	const now = input.now ?? new Date()
	const sources = await listEntitySourcesForExternalReconcile(
		input.env.APP_DB,
		{
			before: minutesAgoIso(
				now,
				input.staleAfterMinutes ?? defaultStaleAfterMinutes,
			),
			limit: input.batchSize ?? defaultBatchSize,
		},
	)
	const result: ReconcileArtifactsPushesResult = {
		checked: 0,
		published: 0,
		alreadyPublished: 0,
		checksFailed: 0,
		notFastForward: 0,
		errors: 0,
		tokensRevoked: 0,
	}
	const shouldCleanupTokens = shouldRunDailyTokenCleanup(now)
	for (const source of sources) {
		result.checked += 1
		try {
			const head = await resolveArtifactSourceHead(input.env, source.repo_id)
			if (shouldCleanupTokens) {
				const cleanup = await revokeStaleArtifactsTokens(
					input.env,
					source.repo_id,
					{ keepAfter: now },
				)
				result.tokensRevoked += cleanup.revoked
			}
			if (!head.commit || head.commit === source.published_commit) {
				result.alreadyPublished += 1
				await updateEntitySource(input.env.APP_DB, {
					id: source.id,
					userId: source.user_id,
					lastExternalCheckAt: now.toISOString(),
				})
				continue
			}
			const sessionId = `external-reconcile-${source.id}`
			const publishResult = await repoSessionRpc(
				input.env,
				sessionId,
			).publishFromExternalRef({
				sessionId,
				sourceId: source.id,
				userId: source.user_id,
				newCommit: head.commit,
				expectedHead: head.commit,
				allowForce: false,
				baseUrl: input.baseUrl,
			})
			switch (publishResult.status) {
				case 'already_published':
					result.alreadyPublished += 1
					break
				case 'published':
					result.published += 1
					break
				case 'checks_failed':
					result.checksFailed += 1
					break
				case 'not_fast_forward':
					result.notFastForward += 1
					break
			}
			await updateEntitySource(input.env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
		} catch (error) {
			result.errors += 1
			console.warn('reconcile_artifacts_pushes source failed', {
				sourceId: source.id,
				repoId: source.repo_id,
				error: error instanceof Error ? error.message : String(error),
			})
			await updateEntitySource(input.env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
		}
	}
	console.info('reconcile_artifacts_pushes', result)
	return result
}
