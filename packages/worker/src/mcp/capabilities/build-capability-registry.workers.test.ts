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
	const codingCollision = defineDomainCapability(
		capabilityDomainNames.coding,
		{
			name: 'collision',
			description: 'b',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
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
	const firstCapability = defineDomainCapability(capabilityDomainNames.packages, {
		name: 'dup',
		description: '1',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	const secondCapability = defineDomainCapability(capabilityDomainNames.packages, {
		name: 'dup',
		description: '2',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
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
	const commandsSchema = capabilitySpec?.inputSchema
		&& typeof capabilitySpec.inputSchema === 'object'
		&& 'properties' in capabilitySpec.inputSchema
		&& capabilitySpec.inputSchema.properties
		&& typeof capabilitySpec.inputSchema.properties === 'object'
		&& 'commands' in capabilitySpec.inputSchema.properties
		? capabilitySpec.inputSchema.properties.commands
		: null

	expect(capabilitySpec).toBeDefined()
	expect(capabilitySpec?.requiredInputFields).toEqual(['commands'])
	expect(capabilitySpec?.inputFields).toContain('commands')
	expect(toolDescriptor).toMatchObject({
		description: capabilitySpec?.description,
		inputSchema: capabilitySpec?.inputSchema,
	})
	expect(commandsSchema).toMatchObject({
		type: 'string',
		description: expect.any(String),
	})
})
