import { type JsonSchemaToolDescriptor } from '@cloudflare/codemode'
import { z, type ZodType } from 'zod'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { type CapabilityDomain } from './domain-metadata.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export const emptyCapabilityInputSchema = z.object({})

export type CapabilityContext = {
	env: Env
	callerContext: McpCallerContext
}

export type CapabilityResult = unknown

export type CapabilityJsonSchema = JsonSchemaToolDescriptor['inputSchema']

// Capability authors may provide Zod or raw JSON Schema.
export type CapabilitySchemaDefinition = CapabilityJsonSchema | ZodType

export type InferCapabilitySchema<TSchema> =
	TSchema extends ZodType<infer TOutput> ? TOutput : Record<string, unknown>

// Authoring-time shape before schemas are normalized to JSON Schema.
export type CapabilityDefinition<
	TInputSchema extends CapabilitySchemaDefinition = CapabilitySchemaDefinition,
	TOutputSchema extends CapabilitySchemaDefinition | undefined =
		| CapabilitySchemaDefinition
		| undefined,
> = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords?: Array<string>
	tags?: Array<string>
	readOnly?: boolean
	idempotent?: boolean
	destructive?: boolean
	requiredRole?: RoleName
	requiredPermission?: PermissionString
	inputSchema: TInputSchema
	outputSchema?: TOutputSchema
	handler: (
		args: InferCapabilitySchema<TInputSchema>,
		ctx: CapabilityContext,
	) => Promise<
		TOutputSchema extends CapabilitySchemaDefinition
			? InferCapabilitySchema<TOutputSchema>
			: CapabilityResult
	>
}

// Runtime/registry shape after schema normalization.
export type Capability = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	requiredRole?: RoleName
	requiredPermission?: PermissionString
	inputSchema: CapabilityJsonSchema
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	inputTypeDefinition: string
	outputTypeDefinition?: string
	handler: (
		args: Record<string, unknown>,
		ctx: CapabilityContext,
	) => Promise<CapabilityResult>
}

export type CapabilitySpec = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	requiredRole?: RoleName
	requiredPermission?: PermissionString
	inputFields: Array<string>
	requiredInputFields: Array<string>
	outputFields: Array<string>
	inputSchema: JsonSchemaToolDescriptor['inputSchema']
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	inputTypeDefinition: string
	outputTypeDefinition?: string
}

/** Registry / MCP instruction row derived from a `DomainSpec`. */
export type CapabilityDomainMetadata = {
	name: CapabilityDomain
	description: string
	keywords?: Array<string>
}

/**
 * Single source of truth for a domain: metadata plus its capabilities.
 * Pass an array of these to `buildCapabilityRegistry` (see `builtin-domains.ts`).
 */
export type DomainSpec = {
	name: CapabilityDomain
	description: string
	keywords?: Array<string>
	capabilities: Array<Capability>
}
