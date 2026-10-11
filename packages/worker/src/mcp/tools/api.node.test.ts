import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { apiToolOutputSchema, registerApiTool } from './api.ts'
import { expectMcpToolStructuredContent } from './mcp-tool-output.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

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

async function createAgent() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const email = 'api-tool@example.com'
	const userId = testStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at)
			 VALUES (1, 'api-tool', ?, 'hash', ?, '2026-01-01T00:00:00.000Z')`,
		)
		.run(email, userId)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		COOKIE_SECRET: 'test-cookie-secret',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const authContext = await buildMcpUserContextFromGrantProps(env, { userId })
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
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
		handler: () => registerTool.mock.calls[0]?.[2] as ToolHandler,
	}
}

test('the api tool registers for signed-in callers and runs operations', async () => {
	const agent = await createAgent()
	expect(agent.registerTool).toHaveBeenCalledTimes(1)
	expect(agent.registerTool.mock.calls[0]?.[0]).toBe('api')

	const me = await agent.handler()({ operationId: 'metaGetCurrentUser' })
	expect(me.isError).toBeUndefined()
	expect(me.structuredContent['operationId']).toBe('metaGetCurrentUser')
	expect(JSON.stringify(me.structuredContent['result'])).toContain(
		'api-tool@example.com',
	)
	expectMcpToolStructuredContent(apiToolOutputSchema, me.structuredContent)

	const unknown = await agent.handler()({ operationId: 'noSuchOperation' })
	expect(unknown.isError).toBe(true)
	expect(unknown.structuredContent.error?.code).toBe('not_found')
	expectMcpToolStructuredContent(apiToolOutputSchema, unknown.structuredContent)

	const executeOnly = await agent.handler()({
		operationId: 'webhookSyntheticDispatch',
		params: { webhookName: 'hook', kodyId: 'demo' },
	})
	expect(executeOnly.isError).toBe(true)
	expect(executeOnly.structuredContent.error?.code).toBe('not_found')
	expectMcpToolStructuredContent(
		apiToolOutputSchema,
		executeOnly.structuredContent,
	)

	const proxy = await agent.handler()({
		operationId: 'capabilityProxyCall',
		params: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(proxy.isError).toBe(true)
	expect(proxy.structuredContent.error?.code).toBe('invalid_request')
	expectMcpToolStructuredContent(apiToolOutputSchema, proxy.structuredContent)
})
