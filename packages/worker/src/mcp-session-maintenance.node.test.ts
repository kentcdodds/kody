import { expect, test, vi } from 'vitest'
import { handleMcpAgentSessionBackfillCompleteRequest } from './mcp-session-maintenance.ts'

test('backfill completion allows ownerless stored objects when failures and conflicts are clear', async () => {
	const run = vi.fn(async () => ({ success: true }))
	const prepare = vi.fn(() => ({
		bind: vi.fn(() => ({ run })),
	}))
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
			APP_DB: { prepare },
		} as unknown as Env,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		key: 'mcp_agent_sessions',
		version: 1,
	})
	expect(prepare).toHaveBeenCalled()
	expect(run).toHaveBeenCalled()
})

test('backfill completion still rejects failures', async () => {
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
						failed: 1,
						conflicts: 0,
						noOwner: 0,
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
		error: expect.any(String),
	})
})
