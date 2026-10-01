import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { apiToolOutputSchema, registerApiTool } from './api.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

type ToolHandler = (input: {
	operationId: string
	params?: Record<string, unknown>
}) => Promise<{
	isError?: boolean
	content: Array<{ type: 'text'; text: string }>
	structuredContent: Record<string, unknown> & {
		error?: { code: string; message: string; details?: unknown }
	}
}>

async function createAgent(input: { flag: boolean }) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const email = 'api-tool@example.com'
	const userId = await createStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at)
			 VALUES (1, 'api-tool', ?, 'hash', ?, '2026-01-01T00:00:00.000Z')`,
		)
		.run(email, userId)
	const setFlag = (enabled: boolean) =>
		sqlite
			.prepare(
				`INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled) VALUES ('mcp-api-tool', 1, ?)
				 ON CONFLICT (flag_key, user_id) DO UPDATE SET enabled = excluded.enabled`,
			)
			.run(enabled ? 1 : 0)
	if (input.flag) setFlag(true)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		COOKIE_SECRET: 'test-cookie-secret',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const authContext = await buildMcpUserContextFromGrantProps(env, { userId })
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.test',
		user: authContext?.user ?? null,
	})
	const registerTool = vi.fn()
	const agent = {
		server: { registerTool },
		getEnv: () => env,
		getCallerContext: () => ({ ...callerContext }),
	}
	await registerApiTool(agent as never)
	return {
		registerTool,
		setFlag,
		handler: () => registerTool.mock.calls[0]?.[2] as ToolHandler,
	}
}

test('the api tool is absent until the flag is on, then runs operations and re-checks per call', async () => {
	const off = await createAgent({ flag: false })
	expect(off.registerTool).not.toHaveBeenCalled()

	const agent = await createAgent({ flag: true })
	expect(agent.registerTool).toHaveBeenCalledTimes(1)
	expect(agent.registerTool.mock.calls[0]?.[0]).toBe('api')
	const outputSchema = z.object(apiToolOutputSchema)

	const me = await agent.handler()({ operationId: 'metaGetCurrentUser' })
	expect(me.isError).toBeUndefined()
	expect(me.structuredContent['operationId']).toBe('metaGetCurrentUser')
	expect(JSON.stringify(me.structuredContent['result'])).toContain(
		'api-tool@example.com',
	)
	expect(outputSchema.safeParse(me.structuredContent).success).toBe(true)

	const unknown = await agent.handler()({ operationId: 'noSuchOperation' })
	expect(unknown.isError).toBe(true)
	expect(unknown.structuredContent.error?.code).toBe('not_found')
	expect(outputSchema.safeParse(unknown.structuredContent).success).toBe(true)

	const proxy = await agent.handler()({
		operationId: 'capabilityProxyCall',
		params: { path: ['kody', 'metaGetCurrentUser'], args: [] },
	})
	expect(proxy.isError).toBe(true)
	expect(proxy.structuredContent.error?.code).toBe('feature_disabled')

	agent.setFlag(false)
	const disabled = await agent.handler()({ operationId: 'metaGetCurrentUser' })
	expect(disabled.isError).toBe(true)
	expect(disabled.structuredContent['error']).toMatchObject({
		code: 'feature_unavailable',
		details: { feature_flag: 'mcp-api-tool' },
	})
})
