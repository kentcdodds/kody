import { type JsonSchemaToolDescriptors } from '@cloudflare/codemode'
import { mathCapabilities } from './math/index.ts'
import { workTriageCapabilities } from './work-triage/index.ts'
import { type Capability, type CapabilitySpec } from './types.ts'

const allCapabilities = [...mathCapabilities, ...workTriageCapabilities]

function createCapabilityMap(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) => [capability.name, capability] as const,
	)
	const duplicates = entries.filter(
		([name], index) =>
			entries.findIndex(([entryName]) => entryName === name) !== index,
	)
	if (duplicates.length > 0) {
		const names = duplicates.map(([name]) => name).join(', ')
		throw new Error(`Duplicate capability names: ${names}`)
	}
	return Object.fromEntries(entries)
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
					inputFields: getSchemaPropertyNames(capability.inputSchema),
					requiredInputFields: getSchemaRequiredFields(capability.inputSchema),
					outputFields: capability.outputSchema
						? getSchemaPropertyNames(capability.outputSchema)
						: [],
					inputSchema: capability.inputSchema,
					...(capability.outputSchema
						? { outputSchema: capability.outputSchema }
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

export const capabilityList = allCapabilities

export const capabilityMap = createCapabilityMap(capabilityList)

export const capabilitySpecs = createCapabilitySpecs(capabilityList)

export const capabilityToolDescriptors =
	createCapabilityToolDescriptors(capabilityList)

export const capabilityHandlers = Object.fromEntries(
	Object.entries(capabilityMap).map(([name, capability]) => [
		name,
		capability.handler,
	]),
) as Record<string, Capability['handler']>
