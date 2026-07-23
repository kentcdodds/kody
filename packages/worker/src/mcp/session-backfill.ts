import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { registerMcpAgentSession } from './session-registry.ts'

export async function backfillMcpAgentSessions(input: {
	env: Env
	doIds: ReadonlyArray<string>
	dryRun: boolean
}) {
	const rows: Array<{
		doId: string
		userId: string | null
		action: 'would_register' | 'registered' | 'already_indexed' | 'no_owner'
	}> = []
	const failures: Array<{ doId: string; error: string }> = []
	for (const doId of new Set(input.doIds)) {
		try {
			const stub = input.env.MCP_OBJECT.get(
				input.env.MCP_OBJECT.idFromString(doId),
			) as unknown as {
				getStoredOwnerForMaintenance: () => Promise<{
					doId: string
					userId: string | null
				}>
			}
			const owner = await stub.getStoredOwnerForMaintenance()
			if (!owner.userId) {
				rows.push({ doId, userId: null, action: 'no_owner' })
				continue
			}
			const existing = await input.env.APP_DB.prepare(
				`SELECT 1 AS owned FROM mcp_agent_sessions
				WHERE do_id = ? AND user_id = ?`,
			)
				.bind(doId, owner.userId)
				.first<{ owned: number }>()
			if (existing?.owned === 1) {
				rows.push({
					doId,
					userId: owner.userId,
					action: 'already_indexed',
				})
				continue
			}
			if (input.dryRun) {
				rows.push({
					doId,
					userId: owner.userId,
					action: 'would_register',
				})
				continue
			}
			await registerMcpAgentSession({
				db: input.env.APP_DB,
				doId,
				userId: owner.userId,
			})
			rows.push({ doId, userId: owner.userId, action: 'registered' })
		} catch (error) {
			failures.push({ doId, error: getErrorMessage(error) })
		}
	}
	return { rows, failures }
}
