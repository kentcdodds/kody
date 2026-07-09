export type OpenApiHttpMethod =
	| 'get'
	| 'put'
	| 'post'
	| 'delete'
	| 'options'
	| 'head'
	| 'patch'
	| 'trace'

export type OpenApiParameter = {
	name: string
	location: 'path' | 'query' | 'header' | 'cookie'
	required: boolean
	description: string | null
	schema: Record<string, unknown> | null // bounded JSON-schema-ish object
}

export type OpenApiRequestBody = {
	required: boolean
	contentType: string | null // preferred content type (prefer application/json)
	schema: Record<string, unknown> | null
}

export type OpenApiOperation = {
	operationId: string | null // raw operationId from the spec, if any
	slug: string // stable snake_case identifier, unique within the spec
	method: OpenApiHttpMethod
	path: string
	summary: string | null
	description: string | null // truncated
	tags: Array<string>
	deprecated: boolean
	parameters: Array<OpenApiParameter>
	requestBody: OpenApiRequestBody | null
	securitySchemeNames: Array<string> // scheme names this operation requires; empty = spec default applies
}

export type OpenApiSecurityScheme = {
	name: string // the key in components.securitySchemes
	type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS' | 'unknown'
	description: string | null
	in: 'header' | 'query' | 'cookie' | null // apiKey only
	parameterName: string | null // apiKey only: the header/query/cookie name
	scheme: string | null // http only: 'bearer', 'basic', ...
	flows: Array<
		'authorizationCode' | 'clientCredentials' | 'implicit' | 'password'
	> // oauth2 only
	authorizationUrl: string | null
	tokenUrl: string | null
	scopes: Array<string>
}

export type OpenApiServer = { url: string; description: string | null }

export type ParsedOpenApiSpec = {
	openapiVersion: string
	title: string | null
	version: string | null
	description: string | null // truncated
	servers: Array<OpenApiServer>
	operations: Array<OpenApiOperation>
	securitySchemes: Array<OpenApiSecurityScheme>
	defaultSecuritySchemeNames: Array<string> // from top-level `security`
	warnings: Array<string>
}
