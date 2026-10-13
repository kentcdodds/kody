/**
 * A trigger instance's stored credential picks (its `enablement` mapping
 * rows) are checked before each run: a pick the enabler can no longer Use
 * (deleted, Use revoked, or a personal grant withdrawn) pauses the
 * enablement instead of starting a run that would fail. It resumes on the
 * next event once the pick is usable again or the enabler maps another.
 * Default layers are not checked: an unusable default falls through, as the
 * run's own resolution does.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { listUsableCredentials } from '#worker/credentials/credential-candidates.ts'
import { enablementMappingPauseResourceType } from '#universal/credential-contracts.ts'
import { type EnablementPauseInput } from './repo.ts'
import { type EnablementPause, type EnablementRecord } from './types.ts'

/** A pause on a stored trigger pick resumes by re-checking the mapping. */
export function isEnablementMappingPause(pause: EnablementPause | null) {
	return (
		pause?.reason === 'credential_access' &&
		pause.resourceType === enablementMappingPauseResourceType
	)
}

async function loadTriggerPicks(db: D1Database, enablement: EnablementRecord) {
	const result = await db
		.prepare(
			`SELECT need_key, credential_ids_json FROM credential_mappings
			WHERE org_id = ? AND package_id = ? AND target = 'enablement'
				AND enablement_id = ?
			ORDER BY need_key`,
		)
		.bind(enablement.orgId, enablement.packageId, enablement.id)
		.all<{ need_key: string; credential_ids_json: string }>()
	return (result.results ?? []).map((row) => {
		const parsed: unknown = JSON.parse(row.credential_ids_json)
		return {
			needKey: row.need_key,
			ids: Array.isArray(parsed)
				? parsed.filter((id): id is string => typeof id === 'string')
				: [],
		}
	})
}

/**
 * The pause a run of `enablement` needs before it starts, or null when every
 * credential its trigger mapping names is usable by the enabler (`request`).
 * "None on purpose" (`[]`) is not a pause; the run reports it.
 */
export async function checkEnablementMappedCredentials(input: {
	env: Env
	request: RequestContext
	enablement: EnablementRecord
}): Promise<EnablementPauseInput | null> {
	if (!input.enablement.packageId) return null
	const picks = (
		await loadTriggerPicks(input.env.APP_DB, input.enablement)
	).filter((pick) => pick.ids.length > 0)
	if (picks.length === 0) return null
	const usable = new Set(
		(await listUsableCredentials(input)).map((credential) => credential.id),
	)
	for (const { needKey, ids } of picks) {
		const missing = ids.find((id) => !usable.has(id))
		if (!missing) continue
		return {
			reason: 'credential_access',
			permission: null,
			resourceType: enablementMappingPauseResourceType,
			resourceId: needKey,
			credentialId: missing,
		}
	}
	return null
}
