import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'

async function readJson(request: Request) {
	const value: unknown = await request.json()
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Maintenance request body must be an object.')
	}
	return value as Record<string, unknown>
}

export async function purgeOwnerlessMcpAgentSessions(input: {
	env: Env
	doIds: ReadonlyArray<string>
}) {
	const namespace = input.env.MCP_OBJECT
	if (!namespace) {
		throw new Error('MCP_OBJECT binding was unavailable.')
	}
	const purged: Array<string> = []
	const skipped: Array<{ doId: string; reason: string }> = []
	const failures: Array<{ doId: string; error: string }> = []
	for (const doId of new Set(input.doIds)) {
		try {
			const stub = namespace.get(namespace.idFromString(doId)) as unknown as {
				getStoredOwnerForMaintenance: () => Promise<{
					doId: string
					userId: string | null
				}>
				purgeIfOwnerlessForMaintenance: () => Promise<{
					doId: string
					action: 'purged'
				}>
			}
			const owner = await stub.getStoredOwnerForMaintenance()
			if (owner.userId !== null) {
				skipped.push({
					doId,
					reason: 'has_owner',
				})
				continue
			}
			await stub.purgeIfOwnerlessForMaintenance()
			purged.push(doId)
		} catch (error) {
			failures.push({ doId, error: getErrorMessage(error) })
		}
	}
	return { purged, skipped, failures }
}

export async function handleOwnerlessMcpSessionPurgeRequest(
	request: Request,
	env: Env,
) {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Ownerless MCP session purge is not configured.',
		async run() {
			const body = await readJson(request)
			const doIds = Array.isArray(body['doIds'])
				? body['doIds'].filter(
						(value): value is string =>
							typeof value === 'string' && value.length > 0,
					)
				: []
			if (doIds.length === 0 || doIds.length > 100) {
				throw new Error('doIds must contain between 1 and 100 object ids.')
			}
			const result = await purgeOwnerlessMcpAgentSessions({ env, doIds })
			return {
				scanned: doIds.length,
				purgedCount: result.purged.length,
				skippedCount: result.skipped.length,
				failureCount: result.failures.length,
				...result,
			}
		},
	})
}
