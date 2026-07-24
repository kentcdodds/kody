import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { type CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type OpenApiBinding,
	type OpenApiBindingOperation,
} from '#worker/openapi/binding-shared.ts'
import {
	openApiCapabilityId,
	openApiDomainId,
	openApiProviderKodyName,
} from '#worker/openapi/openapi-domain-id.ts'
import {
	executeOpenApiOperationRequest,
	type OpenApiOperationRequestArgs,
} from './operation-request.ts'

export type SynthesizedOpenApiDomain = {
	domain: DomainSpec
}

function buildKeywords(
	operation: OpenApiBindingOperation,
	binding: OpenApiBinding,
) {
	const words = [
		'openapi',
		'rest',
		'api',
		operation.slug,
		operation.method,
		operation.path,
		operation.summary ?? '',
		operation.description ?? '',
		...operation.tags,
		binding.name,
	]
	return Array.from(
		new Set(
			words
				.join(' ')
				.toLowerCase()
				.match(/[a-z0-9_]+/g)
				?.filter(Boolean) ?? [],
		),
	)
}

function asSchemaObject(
	schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
		return {}
	}
	return schema
}

export function buildOpenApiOperationInputSchema(
	operation: OpenApiBindingOperation,
): Record<string, unknown> {
	const pathProperties: Record<string, unknown> = {}
	const queryProperties: Record<string, unknown> = {}
	const headerProperties: Record<string, unknown> = {}
	const requiredPathParams: Array<string> = []
	const requiredQueryParams: Array<string> = []
	const requiredHeaderParams: Array<string> = []
	const cookieParamNames: Array<string> = []

	for (const parameter of operation.parameters) {
		const propertySchema = {
			...asSchemaObject(parameter.schema),
			...(parameter.description ? { description: parameter.description } : {}),
		}
		if (parameter.location === 'path') {
			pathProperties[parameter.name] = propertySchema
			if (parameter.required) requiredPathParams.push(parameter.name)
		} else if (parameter.location === 'query') {
			queryProperties[parameter.name] = propertySchema
			if (parameter.required) requiredQueryParams.push(parameter.name)
		} else if (parameter.location === 'header') {
			headerProperties[parameter.name] = propertySchema
			if (parameter.required) requiredHeaderParams.push(parameter.name)
		} else if (parameter.location === 'cookie') {
			cookieParamNames.push(parameter.name)
		}
	}

	const properties: Record<string, unknown> = {}
	const required: Array<string> = []

	if (Object.keys(pathProperties).length > 0) {
		properties.params = {
			type: 'object',
			properties: pathProperties,
			...(requiredPathParams.length > 0
				? { required: requiredPathParams }
				: {}),
			additionalProperties: false,
		}
		if (requiredPathParams.length > 0) required.push('params')
	}

	if (Object.keys(queryProperties).length > 0) {
		properties.query = {
			type: 'object',
			properties: queryProperties,
			...(requiredQueryParams.length > 0
				? { required: requiredQueryParams }
				: {}),
			additionalProperties: true,
		}
		if (requiredQueryParams.length > 0) required.push('query')
	}

	let headersDescription =
		'Optional extra headers. Auth-controlled headers always win.'
	if (cookieParamNames.length > 0) {
		headersDescription += ` Cookie parameters from the spec (${cookieParamNames.join(', ')}) must be passed manually via a "cookie" header.`
	}

	properties.headers = {
		type: 'object',
		...(Object.keys(headerProperties).length > 0
			? { properties: headerProperties }
			: {}),
		...(requiredHeaderParams.length > 0
			? { required: requiredHeaderParams }
			: {}),
		additionalProperties: { type: 'string' },
		description: headersDescription,
	}
	if (requiredHeaderParams.length > 0) required.push('headers')

	if (operation.requestBody) {
		properties.body = {
			...asSchemaObject(operation.requestBody.schema),
			...(operation.requestBody.contentType
				? {
						description: `Request body (${operation.requestBody.contentType}).`,
					}
				: {}),
		}
		if (
			Object.keys(asSchemaObject(operation.requestBody.schema)).length === 0
		) {
			properties.body = true
		}
		if (operation.requestBody.required) required.push('body')
	}

	return {
		type: 'object',
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	}
}

function createCapabilityFromOperation(input: {
	binding: OpenApiBinding
	operation: OpenApiBindingOperation
	domainId: CapabilityDomain
}): Capability {
	const { binding, operation, domainId } = input
	const kodyName = openApiProviderKodyName(binding.name)
	const capabilityName = openApiCapabilityId(binding.name, operation.slug)
	const method = operation.method
	const descriptionParts = [
		operation.summary?.trim() || operation.description?.trim() || null,
		`${method.toUpperCase()} ${operation.path}`,
	].filter(Boolean)

	return defineCapability({
		name: capabilityName,
		domain: domainId,
		description: descriptionParts.join(' — '),
		keywords: buildKeywords(operation, binding),
		readOnly: method === 'get' || method === 'head',
		destructive: method === 'delete',
		source: 'openapi',
		openApi: {
			bindingName: binding.name,
			kodyName,
			operationSlug: operation.slug,
			method,
			path: operation.path,
		},
		inputSchema: buildOpenApiOperationInputSchema(operation),
		async handler(args, ctx) {
			const userId = ctx.callerContext.user?.userId
			if (!userId) {
				throw new McpCallerError(
					`OpenAPI capability "${binding.name}:${operation.slug}" requires an authenticated user.`,
				)
			}
			return executeOpenApiOperationRequest({
				env: ctx.env,
				userId,
				baseUrl: ctx.callerContext.baseUrl,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					packageId: ctx.callerContext.storageContext?.packageId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
				binding,
				operation,
				args: (args ?? {}) as OpenApiOperationRequestArgs,
			})
		},
	})
}

export function synthesizeOpenApiProviderDomain(input: {
	binding: OpenApiBinding
}): SynthesizedOpenApiDomain | null {
	const { binding } = input
	if (!binding.operations || binding.operations.length === 0) {
		return null
	}

	const domainId = openApiDomainId(binding.name)
	const domainIdForCapabilities: CapabilityDomain = domainId
	const domainDescription =
		binding.description?.trim() ||
		binding.specTitle?.trim() ||
		`Capabilities from the curated OpenAPI provider binding "${binding.name}".`

	const capabilities: Array<Capability> = binding.operations.map((operation) =>
		createCapabilityFromOperation({
			binding,
			operation,
			domainId: domainIdForCapabilities,
		}),
	)

	return {
		domain: defineDomain({
			name: domainIdForCapabilities,
			description: domainDescription,
			keywords: ['openapi', 'rest', 'api', 'provider', 'binding'],
			capabilities,
		}),
	}
}
