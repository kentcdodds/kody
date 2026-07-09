import { type JsonSchemaToolDescriptors } from '@cloudflare/codemode'
import { defineDomain } from './define-domain.ts'
import { type CapabilityDomain } from './domain-metadata.ts'
import {
	type Capability,
	type CapabilityDomainMetadata,
	type CapabilitySpec,
	type DomainSpec,
} from './types.ts'

export type BuiltCapabilityRegistry = {
	capabilityList: Array<Capability>
	capabilityDomains: ReadonlyArray<CapabilityDomainMetadata>
	capabilityDomainDescriptionsByName: Record<CapabilityDomain, string>
	capabilityMap: Record<string, Capability>
	capabilitySpecs: Record<string, CapabilitySpec>
	capabilityToolDescriptors: JsonSchemaToolDescriptors
	capabilityHandlers: Record<string, Capability['handler']>
}

export function buildCapabilityRegistry(
	domains: ReadonlyArray<DomainSpec>,
): BuiltCapabilityRegistry {
	const normalized = domains.map((domain) => defineDomain(domain))

	const seenRegistryDomains = new Set<CapabilityDomain>()
	for (const domain of normalized) {
		if (seenRegistryDomains.has(domain.name)) {
			throw new Error(`Duplicate domain registration: ${domain.name}`)
		}
		seenRegistryDomains.add(domain.name)
	}

	const capabilityDomains: ReadonlyArray<CapabilityDomainMetadata> =
		normalized.map((domain) => ({
			name: domain.name,
			description: domain.description,
			...(domain.keywords ? { keywords: domain.keywords } : {}),
		}))

	const capabilityDomainDescriptionsByName = Object.fromEntries(
		normalized.map((domain) => [domain.name, domain.description]),
	) as Record<CapabilityDomain, string>

	const capabilityList = normalized.flatMap((domain) => domain.capabilities)
	const capabilityMap = createCapabilityMap(capabilityList)
	const capabilitySpecs = createCapabilitySpecs(capabilityList)
	const capabilityToolDescriptors =
		createCapabilityToolDescriptors(capabilityList)
	const capabilityHandlers = Object.fromEntries(
		Object.entries(capabilityMap).map(([name, capability]) => [
			name,
			capability.handler,
		]),
	) as Record<string, Capability['handler']>

	return {
		capabilityList,
		capabilityDomains,
		capabilityDomainDescriptionsByName,
		capabilityMap,
		capabilitySpecs,
		capabilityToolDescriptors,
		capabilityHandlers,
	}
}

function createCapabilityMap(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) => [capability.name, capability] as const,
	)
	const seenNames = new Set<string>()
	const duplicateNames = new Set<string>()
	for (const [name] of entries) {
		if (seenNames.has(name)) {
			duplicateNames.add(name)
		} else {
			seenNames.add(name)
		}
	}
	if (duplicateNames.size > 0) {
		throw new Error(
			`Duplicate capability names: ${[...duplicateNames].join(', ')}`,
		)
	}
	return Object.fromEntries(entries) as Record<string, Capability>
}

function createCapabilitySpecs(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) =>
			[
				capability.name,
				{
					name: capability.name,
					domain: capability.domain,
					description: capability.description,
					keywords: capability.keywords,
					readOnly: capability.readOnly,
					idempotent: capability.idempotent,
					destructive: capability.destructive,
					...(capability.requiredRole
						? { requiredRole: capability.requiredRole }
						: {}),
					...(capability.requiredPermission
						? { requiredPermission: capability.requiredPermission }
						: {}),
					source: capability.source ?? 'builtin',
					...(capability.remoteConnector
						? { remoteConnector: capability.remoteConnector }
						: {}),
					...(capability.mcpServer ? { mcpServer: capability.mcpServer } : {}),
					...(capability.openApi ? { openApi: capability.openApi } : {}),
					inputFields: getSchemaPropertyNames(capability.inputSchema),
					requiredInputFields: getSchemaRequiredFields(capability.inputSchema),
					outputFields: capability.outputSchema
						? getSchemaPropertyNames(capability.outputSchema)
						: [],
					inputSchema: capability.inputSchema,
					...(capability.outputSchema
						? { outputSchema: capability.outputSchema }
						: {}),
					inputTypeDefinition: capability.inputTypeDefinition,
					...(capability.outputTypeDefinition
						? { outputTypeDefinition: capability.outputTypeDefinition }
						: {}),
				},
			] as const,
	)
	return Object.fromEntries(entries) as Record<string, CapabilitySpec>
}

function createCapabilityToolDescriptors(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) =>
			[
				capability.name,
				{
					description: capability.description,
					inputSchema: capability.inputSchema,
					...(capability.outputSchema
						? { outputSchema: capability.outputSchema }
						: {}),
				},
			] as const,
	)
	return Object.fromEntries(entries) as JsonSchemaToolDescriptors
}

function getSchemaPropertyNames(schema: unknown) {
	const properties = getSchemaRecordProperty(schema, 'properties')
	return properties ? Object.keys(properties) : []
}

function getSchemaRequiredFields(schema: unknown) {
	const required = getSchemaArrayProperty(schema, 'required')
	return required
		? required.filter((value): value is string => typeof value === 'string')
		: []
}

function getSchemaRecordProperty(schema: unknown, key: string) {
	if (!schema || typeof schema !== 'object') return null
	const value = (schema as Record<string, unknown>)[key]
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

function getSchemaArrayProperty(schema: unknown, key: string) {
	if (!schema || typeof schema !== 'object') return null
	const value = (schema as Record<string, unknown>)[key]
	return Array.isArray(value) ? value : null
}
