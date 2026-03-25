import {
	nullable,
	number,
	object,
	optional,
	string,
	type InferOutput,
} from 'remix/data-schema'

export const aiModeValues = ['mock', 'remote'] as const
export type AiMode = (typeof aiModeValues)[number]

export const mcpUserContextSchema = object({
	userId: string(),
	email: string(),
	displayName: string(),
})

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	user: optional(nullable(mcpUserContextSchema)),
	homeConnectorId: optional(nullable(string())),
})

export type McpUserContext = InferOutput<typeof mcpUserContextSchema>
export type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>

export const chatAgentPropsSchema = object({
	threadId: string(),
	appUserId: number(),
	baseUrl: string(),
	user: mcpUserContextSchema,
})

export type ChatAgentProps = InferOutput<typeof chatAgentPropsSchema>

export const chatThreadRecordSchema = object({
	id: string(),
	user_id: number(),
	title: string(),
	last_message_preview: string(),
	message_count: number(),
	created_at: string(),
	updated_at: string(),
	deleted_at: optional(nullable(string())),
})

export type ChatThreadRecord = InferOutput<typeof chatThreadRecordSchema>

export type ChatThreadSummary = {
	id: string
	title: string
	lastMessagePreview: string | null
	messageCount: number
	createdAt: string
	updatedAt: string
	deletedAt: string | null
}

export type ChatThreadListResponse = {
	ok: true
	threads: Array<ChatThreadSummary>
	hasMore: boolean
	nextCursor: string | null
	totalCount: number
}

export type ChatThreadLookupResponse = {
	ok: true
	thread: ChatThreadSummary
}

export type ChatThreadCreateResponse = {
	ok: true
	thread: ChatThreadSummary
}

export type ChatThreadUpdateResponse = {
	ok: true
	thread: ChatThreadSummary
}
