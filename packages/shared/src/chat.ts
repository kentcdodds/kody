import {
	array,
	createSchema,
	fail,
	nullable,
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

export const mcpUserContextSchema = object({
	userId: string(),
	email: string(),
	username: optional(string()),
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
	remoteConnectors: optional(nullable(array(remoteConnectorRefSchema))),
	storageContext: optional(nullable(mcpStorageContextSchema)),
	repoContext: optional(nullable(mcpRepoContextSchema)),
})

export type McpUserContext = InferOutput<typeof mcpUserContextSchema>
export type McpStorageContext = InferOutput<typeof mcpStorageContextSchema>
export type McpRepoContext = InferOutput<typeof mcpRepoContextSchema>
export type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>
