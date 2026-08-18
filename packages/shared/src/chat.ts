import {
	array,
	literal,
	nullable,
	object,
	optional,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'

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
	packageId: optional(nullable(string())),
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

export const mcpExecutionOriginSchema = union([
	literal('interactive'),
	literal('background'),
])

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	executionOrigin: optional(mcpExecutionOriginSchema),
	user: optional(nullable(mcpUserContextSchema)),
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
export type McpExecutionOrigin = InferOutput<typeof mcpExecutionOriginSchema>
type McpCallerContextInferred = InferOutput<typeof mcpCallerContextSchema>

export type McpCallerContext = Omit<McpCallerContextInferred, 'user'> & {
	user?: McpUserContext | null
}
