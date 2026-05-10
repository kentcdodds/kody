import { expect, test } from 'vitest'
import { z } from 'zod'
import { buildCapabilityRegistry } from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'
import { defineDomain } from './define-domain.ts'
import { defineDomainCapability } from './define-domain-capability.ts'
import { capabilityDomainNames } from './domain-metadata.ts'
import { type CapabilityContext } from './types.ts'

const noopHandler = async (
	_args: Record<string, unknown>,
	_ctx: CapabilityContext,
) => ({})

test('capability domain registration rejects mismatched and duplicate invariants', () => {
	const misplacedCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'orphan',
			description: 'test',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.coding,
			description: 'coding bucket',
			capabilities: [misplacedCapability],
		}),
	).toThrow(/registered under domain/)

	const packagesCollision = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'collision',
			description: 'a',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	const codingCollision = defineDomainCapability(capabilityDomainNames.coding, {
		name: 'collision',
		description: 'b',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		buildCapabilityRegistry([
			defineDomain({
				name: capabilityDomainNames.packages,
				description: 'a',
				capabilities: [packagesCollision],
			}),
			defineDomain({
				name: capabilityDomainNames.coding,
				description: 'c',
				capabilities: [codingCollision],
			}),
		]),
	).toThrow(/Duplicate capability names/)

	const packagesDomain = defineDomain({
		name: capabilityDomainNames.packages,
		description: 'a',
		capabilities: [
			defineDomainCapability(capabilityDomainNames.packages, {
				name: 'only',
				description: 'o',
				inputSchema: z.object({}),
				handler: noopHandler,
			}),
		],
	})
	expect(() =>
		buildCapabilityRegistry([packagesDomain, packagesDomain]),
	).toThrow(/Duplicate domain registration/)
})

test('defineDomain rejects duplicate capability names within one domain', () => {
	const firstCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'dup',
			description: '1',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	const secondCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'dup',
			description: '2',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.packages,
			description: 'a',
			capabilities: [firstCapability, secondCapability],
		}),
	).toThrow(/Duplicate capability .* in domain/)
})

test('repo_run_commands registry spec and tool descriptor stay structurally aligned', () => {
	const registry = buildCapabilityRegistry(builtinDomains)
	const capabilitySpec = registry.capabilitySpecs.repo_run_commands
	const toolDescriptor = registry.capabilityToolDescriptors.repo_run_commands
	const commandsSchema =
		capabilitySpec?.inputSchema &&
		typeof capabilitySpec.inputSchema === 'object' &&
		'properties' in capabilitySpec.inputSchema &&
		capabilitySpec.inputSchema.properties &&
		typeof capabilitySpec.inputSchema.properties === 'object' &&
		'commands' in capabilitySpec.inputSchema.properties
			? capabilitySpec.inputSchema.properties.commands
			: null

	expect(capabilitySpec).toBeDefined()
	expect(capabilitySpec?.requiredInputFields).toEqual(['commands'])
	expect(capabilitySpec?.inputFields).toContain('commands')
	expect(toolDescriptor?.inputSchema).toEqual(capabilitySpec?.inputSchema)
	expect(toolDescriptor?.description).toEqual(expect.any(String))
	expect(commandsSchema).toMatchObject({
		type: 'string',
		description: expect.any(String),
	})
})

test('job_get registry exposes optional source-code inspection fields', () => {
	const registry = buildCapabilityRegistry(builtinDomains)
	const capabilitySpec = registry.capabilitySpecs.job_get
	const toolDescriptor = registry.capabilityToolDescriptors.job_get
	const inputProperties =
		capabilitySpec?.inputSchema &&
		typeof capabilitySpec.inputSchema === 'object' &&
		'properties' in capabilitySpec.inputSchema &&
		capabilitySpec.inputSchema.properties &&
		typeof capabilitySpec.inputSchema.properties === 'object'
			? capabilitySpec.inputSchema.properties
			: null
	const outputProperties =
		capabilitySpec?.outputSchema &&
		typeof capabilitySpec.outputSchema === 'object' &&
		'properties' in capabilitySpec.outputSchema &&
		capabilitySpec.outputSchema.properties &&
		typeof capabilitySpec.outputSchema.properties === 'object'
			? capabilitySpec.outputSchema.properties
			: null
	const includeCodeSchema =
		inputProperties && 'includeCode' in inputProperties
			? inputProperties.includeCode
			: null
	const sourceSchema =
		outputProperties && 'source' in outputProperties
			? outputProperties.source
			: null

	expect(capabilitySpec).toBeDefined()
	expect(capabilitySpec?.inputFields).toEqual(
		expect.arrayContaining(['id', 'job_id', 'includeCode']),
	)
	expect(capabilitySpec?.outputFields).toEqual(
		expect.arrayContaining(['job', 'alarm', 'source']),
	)
	expect(capabilitySpec?.inputTypeDefinition).toContain('includeCode?: boolean')
	expect(capabilitySpec?.outputTypeDefinition).toContain('source?:')
	expect(includeCodeSchema).toMatchObject({
		type: 'boolean',
	})
	expect(sourceSchema).toBeDefined()
	expect(toolDescriptor?.inputSchema).toEqual(capabilitySpec?.inputSchema)
	expect(toolDescriptor?.outputSchema).toEqual(capabilitySpec?.outputSchema)
})
