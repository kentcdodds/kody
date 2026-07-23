import { expect, test } from 'vitest'
import { handleMcpAgentSessionBackfillCompleteRequest } from './mcp-session-maintenance.ts'

test('backfill completion rejects stored objects with no proven owner', async () => {
	const response = await handleMcpAgentSessionBackfillCompleteRequest(
		new Request(
			'https://example.com/__maintenance/backfill-mcp-agent-sessions/complete',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer maintenance-secret',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					auditSummary: {
						failed: 0,
						conflicts: 0,
						noOwner: 1,
					},
				}),
			},
		),
		{
			CAPABILITY_REINDEX_SECRET: 'maintenance-secret',
		} as Env,
	)
	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('unproven ownerless'),
	})
})
