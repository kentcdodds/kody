import {
	array,
	createSchema,
	fail,
	nullable,
	number,
	object,
	optional,
	string,
	type InferOutput,
} from 'remix/data-schema'

const remoteConnectorKindFieldSchema = createSchema<unknown, string>(
	(value, context) => {
		if (typeof value !== 'string') return fail('Expected string', context.path)
		const trimmed = value.trim().toLowerCase()
		if (!trimmed) {
			return fail('remote connector kind must not be empty', context.path)
		}
		return { value: trimmed }
	},
)

const remoteConnectorInstanceIdFieldSchema = createSchema<unknown, string>(
	(value, context) => {
		if (typeof value !== 'string') return fail('Expected string', context.path)
		const trimmed = value.trim()
		if (!trimmed) {
			return fail('remote connector instanceId must not be empty', context.path)
		}
		return { value: trimmed }
	},
)

export const aiModeValues = ['mock', 'remote'] as const
export type AiMode = (typeof aiModeValues)[number]

export const mcpUserContextSchema = object({
	userId: string(),
	email: string(),
	displayName: string(),
})

export const mcpStorageContextSchema = object({
	sessionId: optional(nullable(string())),
	appId: optional(nullable(string())),
	storageId: optional(nullable(string())),
})

export const mcpRepoContextSchema = object({
	sourceId: optional(nullable(string())),
	repoId: optional(nullable(string())),
	sessionId: optional(nullable(string())),
	sessionRepoId: optional(nullable(string())),
	baseCommit: optional(nullable(string())),
	manifestPath: optional(nullable(string())),
	sourceRoot: optional(nullable(string())),
	publishedCommit: optional(nullable(string())),
	entityKind: optional(nullable(string())),
	entityId: optional(nullable(string())),
})

const remoteConnectorRefSchema = object({
	kind: remoteConnectorKindFieldSchema,
	instanceId: remoteConnectorInstanceIdFieldSchema,
})

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	user: optional(nullable(mcpUserContextSchema)),
	homeConnectorId: optional(nullable(string())),
	remoteConnectors: optional(nullable(array(remoteConnectorRefSchema))),
	storageContext: optional(nullable(mcpStorageContextSchema)),
	repoContext: optional(nullable(mcpRepoContextSchema)),
	capabilityRestrictions: optional(
		nullable(
			object({
				denyNames: optional(nullable(array(string()))),
				denyDomains: optional(nullable(array(string()))),
			}),
		),
	),
})

export type McpUserContext = InferOutput<typeof mcpUserContextSchema>
export type McpStorageContext = InferOutput<typeof mcpStorageContextSchema>
export type McpRepoContext = InferOutput<typeof mcpRepoContextSchema>
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
