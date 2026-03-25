import * as Sentry from '@sentry/cloudflare'
import { AIChatAgent } from '@cloudflare/ai-chat'
import {
	type StreamTextOnFinishCallback,
	type ToolSet,
	type UIMessage,
} from 'ai'
import { type Connection, type ConnectionContext } from 'agents'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createChatThreadsStore } from '#app/chat-threads.ts'
import { createMcpCallerContext } from './mcp/context.ts'
import { createAiRuntime, type AiRuntimeResult } from './ai-runtime.ts'
import { buildSentryOptions } from './sentry-options.ts'

function buildSystemPrompt() {
	return [
		'You are a helpful assistant inside kody.',
		'Use MCP tools when they provide a more reliable or interactive result than freeform text.',
		'When a tool is useful, call it instead of guessing.',
	].join(' ')
}

function getTextParts(message: UIMessage) {
	return message.parts
		.filter(
			(
				part,
			): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
				part.type === 'text',
		)
		.map((part) => part.text)
}

function getLatestUserMessageText(messages: Array<UIMessage>) {
	const userMessages = messages.filter((message) => message.role === 'user')
	const latestMessage = userMessages.at(-1)
	if (!latestMessage) return ''
	return getTextParts(latestMessage).join('\n').trim()
}

function buildThreadTitle(messages: Array<UIMessage>) {
	const firstUserMessage = messages.find((message) => message.role === 'user')
	if (!firstUserMessage) return ''
	const text = getTextParts(firstUserMessage).join('\n').trim()
	if (!text) return ''
	return text.slice(0, 120)
}

function buildLastPreview(input: { userText: string; assistantText?: string }) {
	const assistantPreview = input.assistantText?.trim() ?? ''
	if (assistantPreview) return assistantPreview.slice(0, 160)
	return input.userText.trim().slice(0, 160)
}

function createTextResponse(text: string, chunks?: Array<string>) {
	const body = chunks && chunks.length > 0 ? chunks.join('') : text
	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function createErrorResponse(message: string) {
	return new Response(message, {
		status: 500,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

type MockToolCallResult = {
	assistantText: string
}

const defaultMessageHistoryLimit = 40
const maxMessageHistoryLimit = 100

function normalizeMessageHistoryLimit(limit: number | undefined) {
	return Math.max(
		1,
		Math.min(limit ?? defaultMessageHistoryLimit, maxMessageHistoryLimit),
	)
}

function normalizeMessageHistoryIndex(
	index: number | null | undefined,
	totalCount: number,
) {
	if (typeof index !== 'number' || !Number.isFinite(index)) return totalCount
	return Math.max(0, Math.min(Math.trunc(index), totalCount))
}

function createKnownMockToolResult(
	result: Extract<AiRuntimeResult, { kind: 'tool-call' }>,
): MockToolCallResult | null {
	if (result.toolName === 'open_generated_ui') {
		const appId =
			typeof result.input.app_id === 'string' ? result.input.app_id : null
		return {
			assistantText: [
				'## Generated UI ready',
				'',
				'The generated UI is attached to this tool call in MCP-compatible hosts.',
				...(appId ? ['', `Saved app id: \`${appId}\``] : []),
			].join('\n'),
		}
	}

	return null
}

class ChatAgentBase extends AIChatAgent<Env> {
	waitForMcpConnections = true
	private runtimeContext: {
		appUserId: number
		baseUrl: string
		user: ReturnType<typeof createMcpCallerContext>['user']
		homeConnectorId: string | null
	} | null = null

	private getRuntimeContext() {
		if (!this.runtimeContext) {
			this.restoreRuntimeContext()
		}
		if (!this.runtimeContext) {
			throw new Error(
				'Chat agent runtime context has not been initialized yet.',
			)
		}
		return this.runtimeContext
	}

	private ensureRuntimeContextTable() {
		void this.sql`
			CREATE TABLE IF NOT EXISTS chat_agent_runtime_context (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`
	}

	private restoreRuntimeContext() {
		this.ensureRuntimeContextTable()
		const rows =
			this.sql<{ value: string }>`
				SELECT value FROM chat_agent_runtime_context
				WHERE key = 'runtimeContext'
			` || []
		const row = rows[0]
		if (!row) return
		try {
			this.runtimeContext = JSON.parse(row.value) as NonNullable<
				typeof this.runtimeContext
			>
		} catch {
			this.runtimeContext = null
		}
	}

	private persistRuntimeContext() {
		if (!this.runtimeContext) return
		this.ensureRuntimeContextTable()
		void this.sql`
			INSERT OR REPLACE INTO chat_agent_runtime_context (key, value)
			VALUES ('runtimeContext', ${JSON.stringify(this.runtimeContext)})
		`
	}

	private getThreadStore() {
		return createChatThreadsStore(this.env.APP_DB)
	}

	getMessagePage(input?: {
		before?: number | null
		limit?: number
		start?: number | null
	}) {
		const totalCount = this.messages.length
		const limit = normalizeMessageHistoryLimit(input?.limit)
		const startIndex =
			input?.start !== undefined && input.start !== null
				? normalizeMessageHistoryIndex(input.start, totalCount)
				: Math.max(
						normalizeMessageHistoryIndex(input?.before, totalCount) - limit,
						0,
					)
		const endIndex =
			input?.start !== undefined && input.start !== null
				? totalCount
				: normalizeMessageHistoryIndex(input?.before, totalCount)
		const messages = this.messages.slice(startIndex, endIndex)

		return {
			messages,
			hasMore: startIndex > 0,
			nextBefore: startIndex > 0 ? String(startIndex) : null,
			startIndex,
			totalCount,
		}
	}

	private async syncThreadMetadata(input: {
		assistantText?: string
		messageCountOffset?: number
	}) {
		const { appUserId } = this.getRuntimeContext()
		const threadId = this.name
		const threadStore = this.getThreadStore()
		const currentThread = await threadStore.getForUser(appUserId, threadId)
		if (!currentThread) {
			throw new Error('Thread not found.')
		}
		const autoTitle = buildThreadTitle(this.messages)
		const title =
			currentThread.title.trim() === 'New chat' ||
			currentThread.title.trim() === autoTitle
				? autoTitle
				: undefined
		const userText = getLatestUserMessageText(this.messages)
		const messageCount = this.messages.length + (input.messageCountOffset ?? 0)
		const updatedThread = await threadStore.syncMetadataForUser({
			userId: appUserId,
			threadId,
			title,
			lastMessagePreview: buildLastPreview({
				userText,
				assistantText: input.assistantText,
			}),
			messageCount,
		})
		if (!updatedThread) {
			throw new Error('Thread not found.')
		}
		return updatedThread
	}

	private async initializeRuntimeContextFromRequest(request: Request) {
		const user = await readAuthenticatedAppUser(request, this.env)
		if (!user) {
			throw new Error('Unauthorized chat agent connection.')
		}
		const thread = await this.getThreadStore().getForUser(
			user.userId,
			this.name,
		)
		if (!thread) {
			throw new Error('Thread not found for authenticated user.')
		}
		const baseUrl = new URL(request.url).origin
		this.runtimeContext = {
			appUserId: user.userId,
			baseUrl,
			user: user.mcpUser,
			homeConnectorId: 'default',
		}
		this.persistRuntimeContext()
		await this.addMcpServer('kody', this.env.MCP_OBJECT, {
			props: createMcpCallerContext({
				baseUrl,
				user: user.mcpUser,
				homeConnectorId: this.runtimeContext.homeConnectorId,
			}),
		})
		await this.addMcpServer('home', this.env.HOME_MCP_OBJECT, {
			props: createMcpCallerContext({
				baseUrl,
				user: user.mcpUser,
				homeConnectorId: this.runtimeContext.homeConnectorId,
			}),
		})
	}

	async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		await this.initializeRuntimeContextFromRequest(ctx.request)
		void connection
	}

	async onRequest(request: Request): Promise<Response> {
		try {
			await this.initializeRuntimeContextFromRequest(request)
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === 'Thread not found.' ||
					error.message === 'Thread not found for authenticated user.')
			) {
				return new Response('Thread not found.', { status: 404 })
			}
			if (error instanceof Error && error.message.includes('Unauthorized')) {
				return new Response('Unauthorized', { status: 401 })
			}
			return createErrorResponse('Failed to initialize chat agent.')
		}
		return new Response('Not implemented', { status: 404 })
	}

	private async createMockToolCallResponse(
		result: Extract<AiRuntimeResult, { kind: 'tool-call' }>,
	) {
		const knownMockToolResult = createKnownMockToolResult(result)
		if (knownMockToolResult) {
			await this.syncThreadMetadata({
				assistantText: knownMockToolResult.assistantText,
				messageCountOffset: 1,
			})
			return createTextResponse(knownMockToolResult.assistantText)
		}

		const tool = this.mcp
			.listTools()
			.find((entry) => entry.name === result.toolName)
		if (!tool) {
			return createErrorResponse(
				`Mock tool "${result.toolName}" is not available.`,
			)
		}

		let toolResult: Awaited<ReturnType<typeof this.mcp.callTool>>
		try {
			toolResult = await this.mcp.callTool({
				serverId: tool.serverId,
				name: result.toolName,
				arguments: result.input,
			})
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown mock tool error.'
			return createErrorResponse(
				`Mock tool "${result.toolName}" failed to execute: ${message}`,
			)
		}
		const output =
			'structuredContent' in toolResult && toolResult.structuredContent
				? toolResult.structuredContent
				: toolResult.content
		const toolContents = Array.isArray(toolResult.content)
			? (toolResult.content as Array<{ type: string; text?: string }>)
			: []

		const assistantText =
			result.text?.trim() ||
			toolContents
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n')
				.trim()

		await this.syncThreadMetadata({
			assistantText,
			messageCountOffset: 1,
		})

		const fallbackText =
			assistantText ||
			(typeof output === 'string' ? output : JSON.stringify(output, null, 2))
		return createTextResponse(fallbackText)
	}

	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>,
		options?: { abortSignal?: AbortSignal },
	): Promise<Response | undefined> {
		const aiRuntime = createAiRuntime(this.env)
		const tools = this.mcp.getAITools()
		const toolNames = this.mcp.listTools().map((tool) => tool.name)
		const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (
			event,
		) => {
			await onFinish(event)
			await this.syncThreadMetadata({
				assistantText: event.text,
				messageCountOffset: 1,
			})
		}

		await this.syncThreadMetadata({})

		const runtimeResult = await aiRuntime.streamChatReply({
			messages: this.messages,
			system: buildSystemPrompt(),
			tools,
			toolNames,
			abortSignal: options?.abortSignal,
			onFinish: wrappedOnFinish,
		})

		if (runtimeResult.kind === 'response') {
			return runtimeResult.response
		}

		if (runtimeResult.kind === 'error') {
			return createErrorResponse(runtimeResult.message)
		}

		if (runtimeResult.kind === 'tool-call') {
			return this.createMockToolCallResponse(runtimeResult)
		}

		await this.syncThreadMetadata({
			assistantText: runtimeResult.text,
			messageCountOffset: 1,
		})
		return createTextResponse(runtimeResult.text, runtimeResult.chunks)
	}

	async clearThread() {
		await this.getThreadStore().syncMetadataForUser({
			userId: this.getRuntimeContext().appUserId,
			threadId: this.name,
			lastMessagePreview: null,
			messageCount: 0,
			title: 'New chat',
		})
	}
}

export const ChatAgent = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	ChatAgentBase,
)
