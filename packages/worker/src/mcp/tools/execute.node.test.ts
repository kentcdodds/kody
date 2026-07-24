import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, vi } from 'vitest'
import {
	defaultMcpContentLimitBytes,
	maxMcpContentBlockCount,
	wrapDownstreamMcpToolResult,
} from '#mcp/downstream-mcp-result.ts'
import { formatRawFetchHostNudge } from '#mcp/raw-fetch-host-nudge.ts'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	createExecutePackageInvokeTools: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilityHandlers: {
			coding_guide_get: true,
		},
	})),
	listOpenApiBindings: vi.fn(async () => []),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	createExecutePackageInvokeTools: (...args: Array<unknown>) =>
		mockModule.createExecutePackageInvokeTools(...args),
}))

vi.mock('#worker/openapi/binding-service.ts', () => ({
	listOpenApiBindings: (...args: Array<unknown>) =>
		mockModule.listOpenApiBindings(...args),
}))

const { registerExecuteTool } = await import('./execute.ts')

/**
 * Minimal env stub: the daily execute entitlement consumed at the top of
 * the tool handler issues one conditional upsert (allowed when
 * meta.changes > 0). Plan lookup never touches D1 because these caller
 * contexts carry no account email (resolves to `max`).
 */
const stubEnv = {
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							return null
						},
					}
				},
			}
		},
	},
}

const mockPerformanceNow = vi.spyOn(performance, 'now')

function mockPerformanceSequence(...values: Array<number>) {
	let index = 0
	mockPerformanceNow.mockImplementation(() => {
		const value = values[Math.min(index, values.length - 1)] ?? 0
		index += 1
		return value
	})
}

async function getExecuteRegistration(
	callerContext: {
		baseUrl: string
		user: null | {
			userId: string
			email?: string
			displayName?: string
		}
	} = {
		baseUrl: 'https://example.com',
		user: null,
	},
	agentExtras: {
		state?: Record<string, unknown>
		setState?: (state: Record<string, unknown>) => void
	} = {},
) {
	vi.clearAllMocks()
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => stubEnv),
		getCallerContext: vi.fn(() => callerContext),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
		...agentExtras,
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	return registerTool.mock.calls[0] as [
		string,
		{ description: string },
		(input: {
			code: string
			storageId?: string
			writable?: boolean
			responseLimit?: number
			conversationId?: string
		}) => Promise<{
			content: Array<ContentBlock>
			structuredContent: {
				conversationId: string
				storage?: { id: string }
				returnedBytes: number
				truncated?: boolean
				note?: string
				warnings?: Array<string>
				timing: {
					startedAt: string
					endedAt: string
					durationMs: number
				}
				result: unknown
				logs: Array<unknown>
				error?: string
			}
			isError: boolean
		}>,
	]
}

async function getExecuteHandler(
	callerContext?: Parameters<typeof getExecuteRegistration>[0],
	agentExtras?: Parameters<typeof getExecuteRegistration>[1],
) {
	const [, , handler] = await getExecuteRegistration(callerContext, agentExtras)
	return handler as (input: {
		code: string
		storageId?: string
		writable?: boolean
		responseLimit?: number
		conversationId?: string
	}) => Promise<{
		content: Array<ContentBlock>
		structuredContent: {
			conversationId: string
			storage?: { id: string }
			returnedBytes: number
			truncated?: boolean
			note?: string
			warnings?: Array<string>
			timing: {
				startedAt: string
				endedAt: string
				durationMs: number
			}
			result: unknown
			logs: Array<unknown>
			error?: string
		}
		isError: boolean
	}>
}

test('execute tool description preserves exact prose', async () => {
	const [, options] = await getExecuteRegistration()
	expect(options.description).toMatchInlineSnapshot(`
		"Run one ephemeral ESM module string with a default export. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime (e.g. \`p-retry\`, \`mailparser\`, \`remark\`); prefer existing packages over rewriting helpers. Discover capability names with \`search\`; for one capability’s executable snippet and TypeScript call shape, call \`search\` with \`entity: "{name}:capability"\` or use \`meta_list_capabilities\`.

		Projection rule: you write the code -- if a call returns a large response, project the fields you need before returning. Never return raw API responses; extract a slim shape (e.g. \`{ id, subject, snippet }\`) or a summary.

		Sandbox surface:
		- Import runtime helpers from \`kody:runtime\`.
		- \`import { kody } from 'kody:runtime'\` for builtin capabilities discovered by \`search\`; call valid identifier names as \`await kody.capability_id(input)\`. If a capability id is not a valid JavaScript identifier, use bracket notation: \`await kody["capability-id"](input)\`. Capability detail from \`search({ entity: "{name}:capability" })\` includes the exact snippet.
		- Remote connector, user-added MCP server, and curated OpenAPI capabilities use namespaced accessors: \`await kody.remote["name"].capability_name(input)\`, \`await kody.mcp["server-name"].tool_name(input)\`, and \`await kody.openapi["name"].operation_slug(input)\` — never a flat \`kody.kind_instance_capability(...)\` call.
		- Storage, one rule per context: ad hoc execute code uses \`import { storage } from 'kody:runtime'\` against the \`storageId\` bound to the call; saved-package code always uses \`packageStorage()\` from 'kody:runtime' for the package's own data (package repo checks fail on ambient \`storage\` imports); another package's data goes through \`packages.invokeChecked\`.
		- \`storage\` exposes \`get\`/\`set\`/\`list\`/\`delete\`/\`clear\` and \`storage.sql(query, params?)\`, which returns \`{ columns, rows, rowCount, rowsRead, rowsWritten }\`; read query rows from \`.rows\`. It is \`undefined\` when the call binds no \`storageId\`, and always \`undefined\` in saved-package invocation runs, which bind no ambient storage.
		- \`packageStorage()\` returns the same storage interface bound to the declaring package's own bucket, in the package's own runtime and when the module is statically imported (\`kody:@scope/package/export\`) into an execute call or another package — no \`storageId\` needed. Inline execute code has no package provenance, so \`packageStorage()\` throws there.
		- \`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'\` for OAuth integrations and secret-derived auth headers. Integration \`name\` may be account-specific (e.g. \`google-personal\`, \`google-business\`); call \`integration_list\` first when a provider may have multiple accounts connected. For client-credentials Basic Auth, save the id and secret separately and use \`secretHeaders.basic({ usernameSecret, passwordSecret, scope })\` in the Authorization header, or \`oauthClientCredentials(...)\` for the token request; do not ask users to precompute a derived Basic header.
		- \`import { workflows } from 'kody:runtime'\` for durable Cloudflare Workflows. \`workflows.create\` accepts either inline \`code\` or a saved-package \`exportName\`; use \`workflow_run_list\` to inspect recent runs.
		- Execute has a hard timeout (~90s by default). For batch sweeps, migrations, polling loops, or work likely to run >~60s, submit one durable \`workflows.create({ code, params })\` from a single execute call instead of chaining many MCP round-trips.
		- Optional \`params\` are passed as the first argument to the module default export. Prefer \`export default async function main(input = {}) { ... }\`; pass \`input\` to shared helpers explicitly.
		- \`import { packageContext } from 'kody:runtime'\` in saved package code when you need package metadata; it is \`null\` for ad hoc execute calls.
		- \`import { packages } from 'kody:runtime'\` exposes \`packages.check(...)\`, \`packages.invoke(...)\`, and \`packages.invokeChecked(...)\` in saved package runtime contexts and authenticated ad hoc execute calls. Prefer \`invokeChecked\` for dynamic current-version package calls. Static cross-package imports such as \`kody:@scope/my-package/export-name\` bundle a published snapshot.
		- \`fetch(...)\` is the host-provided network global; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` work in URL, headers, or body on approved hosts only. \`secretHeaders.basic(...)\` returns an opaque placeholder for fetch headers; the gateway resolves both referenced secrets, enforces host approval for both, and sends only the derived Basic header. For host approval failures, use the error’s approval path.
		- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
		- Placeholders are not general string interpolation (they do not resolve in arbitrary return values). Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings; obfuscate the \`{{secret:...}}\` token if you must describe it literally.
		- \`await kody.secret_list({ scope? })\` — metadata only. \`secret_set\` — persist values already in trusted execution (e.g. refreshed tokens); write-only. No \`secret_get\` / \`secrets\` helpers in the sandbox.
		- \`value_get\` / \`value_list\` for non-secret persisted config.

		Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.

		Example:

		\`import { kody } from 'kody:runtime'

		export default async function main(input = {}) {
		  void input;
		  return await kody.coding_guide_get({
		    guide: 'integration_bootstrap',
		  });
		}\`

		To return non-text MCP content blocks (e.g. images), see: https://github.com/kentcdodds/kody/blob/main/docs/use/raw-content-blocks.md

		More context: https://github.com/kentcdodds/kody/blob/main/docs/use/execute.md"
	`)
})

test('execute tool serializes successes and errors, binds storage, passes package invoke tools, and truncates oversized returns', async () => {
	const handler = await getExecuteHandler()
	const rawContent: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{
			type: 'text',
			text: 'Screenshot of https://example.com',
		},
	]
	mockPerformanceSequence(100, 142)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: rawContent,
		},
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})
	const returnedBytes = new TextEncoder().encode(
		JSON.stringify(rawContent),
	).byteLength

	const mcpContentResponse = await handler({
		code: 'async () => ({ __mcpContent: [] })',
		conversationId: 'conv-123',
	})

	expect(mockModule.getCapabilityRegistryForContext).toHaveBeenCalledTimes(1)
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		'async () => ({ __mcpContent: [] })',
		undefined,
		expect.objectContaining({
			capabilityRegistry: {
				capabilityHandlers: {
					coding_guide_get: true,
				},
			},
		}),
	)
	expect(mcpContentResponse.isError).toBe(false)
	expect(mcpContentResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-123',
		},
		...rawContent,
	])
	expect(mcpContentResponse.structuredContent).toEqual({
		conversationId: 'conv-123',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 42,
		},
		returnedBytes,
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})

	mockPerformanceSequence(10, 19)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const jsonResponse = await handler({
		code: 'async () => ({ ok: true })',
		conversationId: 'conv-456',
	})

	expect(jsonResponse.isError).toBe(false)
	expect(jsonResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-456',
		},
		{
			type: 'text',
			text: '{\n  "ok": true\n}',
		},
	])
	expect(jsonResponse.structuredContent).toEqual({
		conversationId: 'conv-456',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 9,
		},
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	mockPerformanceSequence(1, 8)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	const storageResponse = await handler({
		code: 'async () => ({ ok: true })',
		storageId: 'job:lights-off',
		writable: true,
		conversationId: 'conv-789',
	})

	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: 'job:lights-off',
			},
		}),
		'async () => ({ ok: true })',
		undefined,
		expect.objectContaining({
			storageTools: {
				userId: '',
				storageId: 'job:lights-off',
				writable: true,
			},
		}),
	)
	expect(storageResponse.structuredContent).toEqual({
		conversationId: 'conv-789',
		storage: { id: 'job:lights-off' },
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 7,
		},
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	const packageInvokeTools = {
		check: vi.fn(),
		invoke: vi.fn(),
		invokeChecked: vi.fn(),
	}
	mockModule.createExecutePackageInvokeTools.mockReturnValueOnce(
		packageInvokeTools,
	)
	const callerContext = {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	}
	const authenticatedHandler = await getExecuteHandler(callerContext)
	mockPerformanceSequence(9, 12)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})

	await authenticatedHandler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-packages',
	})

	expect(mockModule.createExecutePackageInvokeTools).toHaveBeenCalledWith({
		env: stubEnv,
		baseUrl: 'https://example.com',
		callerContext: expect.objectContaining(callerContext),
		conversationId: 'conv-packages',
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining(callerContext),
		'export default async () => ({ ok: true })',
		undefined,
		expect.objectContaining({
			packageInvokeTools,
			conversationId: 'conv-packages',
		}),
	)

	mockPerformanceSequence(20, 25)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: 'hello world',
		logs: [],
	})

	const truncatedStringResponse = await handler({
		code: 'async () => "hello world"',
		responseLimit: 5,
		conversationId: 'conv-truncated-string',
	})

	expect(truncatedStringResponse.isError).toBe(false)
	expect(truncatedStringResponse.content).toEqual([
		{
			type: 'text',
			text: 'conversationId: conv-truncated-string',
		},
		{
			type: 'text',
			text: 'hello\n\n--- TRUNCATED ---\nReturned value was 11 bytes, exceeding responseLimit 5 bytes; output was truncated. Project fields before returning.',
		},
	])
	expect(truncatedStringResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-string',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 5,
		},
		returnedBytes: 11,
		truncated: true,
		note: 'Returned value was 11 bytes, exceeding responseLimit 5 bytes; output was truncated. Project fields before returning.',
		result: 'hello',
		logs: [],
	})

	mockPerformanceSequence(30, 40)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: { rows: [{ id: 'message-1', payload: 'abcdef' }] },
		logs: [],
	})

	const truncatedObjectResponse = await handler({
		code: 'async () => ({ rows: [{ id: "message-1", payload: "abcdef" }] })',
		responseLimit: 10,
		conversationId: 'conv-truncated-object',
	})

	expect(truncatedObjectResponse.isError).toBe(false)
	expect(truncatedObjectResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-object',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 10,
		},
		returnedBytes: 48,
		truncated: true,
		note: 'Returned value was 48 bytes, exceeding responseLimit 10 bytes; output was truncated. Project fields before returning.',
		result: {
			truncated: true,
			type: 'object',
		},
		logs: [],
	})

	mockPerformanceSequence(50, 65)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		error: new Error('Boom'),
		logs: [{ level: 'error', message: 'failed' }],
	})

	const errorResponse = await handler({
		code: 'async () => { throw new Error("Boom") }',
		conversationId: 'conv-error',
	})

	expect(errorResponse.isError).toBe(true)
	expect(errorResponse.structuredContent).toEqual(
		expect.objectContaining({
			conversationId: 'conv-error',
			timing: {
				startedAt: expect.any(String),
				endedAt: expect.any(String),
				durationMs: 15,
			},
			error: 'Boom',
			returnedBytes: 0,
			logs: [{ level: 'error', message: 'failed' }],
		}),
	)
})

test('execute passes through downstream MCP image content with structured data and rejects oversize content explicitly', async () => {
	const handler = await getExecuteHandler()
	const webpBlock = {
		type: 'image' as const,
		data: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
		mimeType: 'image/webp',
	}

	mockPerformanceSequence(1, 2)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: wrapDownstreamMcpToolResult(
			{
				content: [webpBlock],
				structuredContent: { shotId: 's1' },
			},
			{ kind: 'mcp-server', label: 'vision:screenshot' },
		),
		logs: [],
	})

	const passthroughResponse = await handler({
		code: 'async () => downstream',
		conversationId: 'conv-passthrough',
	})

	expect(passthroughResponse.isError).toBe(false)
	expect(passthroughResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-passthrough' },
		webpBlock,
	])
	expect(passthroughResponse.structuredContent.result).toEqual({
		shotId: 's1',
	})

	const largeData = 'A'.repeat(Math.ceil(110_000 / 4) * 4)
	const largeBlock = {
		type: 'image' as const,
		data: largeData,
		mimeType: 'image/webp',
	}
	mockPerformanceSequence(3, 4)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [largeBlock],
		},
		logs: [],
	})

	const largeResponse = await handler({
		code: 'async () => large',
		conversationId: 'conv-large-image',
		responseLimit: 102_400,
	})

	expect(largeResponse.isError).toBe(false)
	expect(largeResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-large-image' },
		largeBlock,
	])

	const tooLargeData = 'A'.repeat(
		Math.ceil((defaultMcpContentLimitBytes + 50_000) / 4) * 4,
	)
	mockPerformanceSequence(5, 6)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [
				{
					type: 'image',
					data: tooLargeData,
					mimeType: 'image/png',
				},
			],
		},
		logs: [],
	})

	const oversizeResponse = await handler({
		code: 'async () => oversize',
		conversationId: 'conv-oversize',
	})

	expect(oversizeResponse.isError).toBe(true)
	expect(oversizeResponse.structuredContent.error).toContain(
		'exceeding content limit',
	)
	expect(oversizeResponse.content[1]).toMatchObject({
		type: 'text',
		text: expect.stringContaining('exceeding content limit'),
	})

	// Ordinary application objects with a `content` array stay JSON text.
	mockPerformanceSequence(7, 8)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			content: [webpBlock],
			ok: true,
		},
		logs: [],
	})
	const arbitraryContentResponse = await handler({
		code: 'async () => ({ content: [...] })',
		conversationId: 'conv-arbitrary-content',
	})
	expect(arbitraryContentResponse.isError).toBe(false)
	expect(arbitraryContentResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-arbitrary-content' },
		{
			type: 'text',
			text: JSON.stringify({ content: [webpBlock], ok: true }, null, 2),
		},
	])
	expect(arbitraryContentResponse.content.some((b) => b.type === 'image')).toBe(
		false,
	)

	// Malformed user-authored __mcpContent becomes an isError result (no throw).
	mockPerformanceSequence(9, 10)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: [{ type: 'image', data: '!!!', mimeType: 'image/png' }],
		},
		logs: [],
	})
	const malformedResponse = await handler({
		code: 'async () => bad',
		conversationId: 'conv-malformed',
	})
	expect(malformedResponse.isError).toBe(true)
	expect(malformedResponse.structuredContent.error).toMatch(
		/default export \(__mcpContent\)[\s\S]*malformed MCP content/,
	)
	expect(malformedResponse.content.some((b) => b.type === 'image')).toBe(false)

	// Too many content blocks fail before expensive validation work.
	mockPerformanceSequence(11, 12)
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result: {
			__mcpContent: Array.from({ length: maxMcpContentBlockCount + 1 }, () => ({
				type: 'text',
				text: 'x',
			})),
		},
		logs: [],
	})
	const tooManyBlocksResponse = await handler({
		code: 'async () => many',
		conversationId: 'conv-too-many-blocks',
	})
	expect(tooManyBlocksResponse.isError).toBe(true)
	expect(tooManyBlocksResponse.structuredContent.error).toContain(
		'too many MCP content blocks',
	)
})

test('execute tool nudges repeated raw-fetch hosts once per conversation and skips OpenAPI-covered hosts', async () => {
	const agentState: Record<string, unknown> = {}
	const setState = vi.fn((next: Record<string, unknown>) => {
		for (const key of Object.keys(agentState)) {
			delete agentState[key]
		}
		Object.assign(agentState, next)
	})
	const handler = await getExecuteHandler(
		{
			baseUrl: 'https://example.com',
			user: { userId: 'user-1', email: 'user@example.com' },
		},
		{
			state: agentState,
			setState,
		},
	)

	mockModule.runModuleWithRegistry.mockImplementation(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('api.notion.com')
			options.rawFetchHostSink?.add('api.notion.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(1, 2)
	const below = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(below.structuredContent.warnings).toBeUndefined()

	mockPerformanceSequence(3, 4)
	const tipped = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(tipped.structuredContent.warnings).toEqual([
		formatRawFetchHostNudge({
			hostname: 'api.notion.com',
			count: 4,
		}),
	])
	expect(setState).toHaveBeenCalled()
	expect(mockModule.listOpenApiBindings).toHaveBeenCalled()

	mockPerformanceSequence(5, 6)
	const again = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-nudge',
	})
	expect(again.structuredContent.warnings).toBeUndefined()

	mockModule.listOpenApiBindings.mockResolvedValueOnce([
		{
			name: 'kit',
			apiBaseUrl: 'https://api.kit.com/v4',
		},
	])
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('api.kit.com')
			options.rawFetchHostSink?.add('api.kit.com')
			options.rawFetchHostSink?.add('api.kit.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(7, 8)
	const covered = await handler({
		code: 'export default async () => ({ ok: true })',
		conversationId: 'conv-covered',
	})
	expect(covered.structuredContent.warnings).toBeUndefined()

	// Integration-auth helper source sharpens the packages-first warning text.
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		async (
			_env,
			_ctx,
			_code,
			_params,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			options.rawFetchHostSink?.add('gmail.googleapis.com')
			return { result: { ok: true }, logs: [] }
		},
	)
	mockPerformanceSequence(9, 10)
	const authHelperTipped = await handler({
		code: `import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => ({ ok: true })`,
		conversationId: 'conv-oauth-nudge',
	})
	expect(authHelperTipped.structuredContent.warnings).toEqual([
		formatRawFetchHostNudge({
			hostname: 'gmail.googleapis.com',
			count: 3,
			usedIntegrationAuthHelpers: true,
		}),
	])
	expect(authHelperTipped.structuredContent.warnings?.[0]).not.toBe(
		tipped.structuredContent.warnings?.[0],
	)
})
