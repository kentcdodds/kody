import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { type RemoteConnectorInstructionSummary } from './server-instructions.ts'
import { createRemoteConnectorMcpClient } from '#worker/remote-connector/client.ts'
import { remoteConnectorDomainId } from '#worker/remote-connector/remote-domain-id.ts'

export async function loadRemoteConnectorInstructionSummaries(input: {
	env: Env
	caller: McpCallerContext
}): Promise<Array<RemoteConnectorInstructionSummary>> {
	const refs = normalizeRemoteConnectorRefs(input.caller)
	const userId = input.caller.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return []
	}
	const snapshots = await Promise.all(
		refs.map(async (ref) => {
			try {
				const snapshot = await createRemoteConnectorMcpClient({
					env: input.env,
					userId,
					instanceId: ref.instanceId,
				}).getSnapshot()
				if (!snapshot) return null
				const connectorId = snapshot.connectorId.trim()
				return {
					name: connectorId,
					domain: remoteConnectorDomainId(ref),
					description: snapshot.description ?? null,
				}
			} catch {
				// A stalled or unavailable connector must not fail MCP session
				// initialization; omit its instruction summary instead.
				return null
			}
		}),
	)
	return snapshots.flatMap((snapshot) => (snapshot ? [snapshot] : []))
}
