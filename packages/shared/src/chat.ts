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
	roles: optional(array(string())),
	permissions: optional(array(string())),
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
	baseCommit: optional(nullable(string())),
	manifestPath: optional(nullable(string())),
	sourceRoot: optional(nullable(string())),
	publishedCommit: optional(nullable(string())),
	entityKind: optional(nullable(string())),
	entityId: optional(nullable(string())),
})

const remoteConnectorRefSchema = object({
	instanceId: remoteConnectorInstanceIdFieldSchema,
})

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	user: optional(nullable(mcpUserContextSchema)),
	remoteConnectors: optional(nullable(array(remoteConnectorRefSchema))),
	storageContext: optional(nullable(mcpStorageContextSchema)),
	repoContext: optional(nullable(mcpRepoContextSchema)),
})

type McpUserContextInferred = InferOutput<typeof mcpUserContextSchema>

export type McpUserContext = Omit<
	McpUserContextInferred,
	'roles' | 'permissions' | 'username'
> & {
	username?: string
	roles?: Array<string>
	permissions?: Array<string>
}
export type McpStorageContext = InferOutput<typeof mcpStorageContextSchema>
export type McpRepoContext = InferOutput<typeof mcpRepoContextSchema>
type McpCallerContextInferred = InferOutput<typeof mcpCallerContextSchema>

export type McpCallerContext = Omit<McpCallerContextInferred, 'user'> & {
	user?: McpUserContext | null
}
