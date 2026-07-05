import { expect, test } from 'vitest'
import { z } from 'zod'
import { buildCapabilityRegistry } from './build-capability-registry.ts'
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

test('capability registry routes hidden deprecated aliases without adding search specs', async () => {
	const aliasedCapability = defineDomainCapability(capabilityDomainNames.meta, {
		name: 'new_name',
		description: 'New capability.',
		aliases: [
			{
				name: 'old_name',
				description: 'Use new_name instead.',
			},
		],
		inputSchema: z.object({}),
		outputSchema: z.object({ ok: z.boolean() }),
		handler: async () => ({ ok: true }),
	})

	const registry = buildCapabilityRegistry([
		defineDomain({
			name: capabilityDomainNames.meta,
			description: 'meta',
			capabilities: [aliasedCapability],
		}),
	])

	expect(registry.capabilityMap.old_name).toBe(registry.capabilityMap.new_name)
	expect(registry.capabilityHandlers.old_name).toBe(
		registry.capabilityHandlers.new_name,
	)
	expect(registry.capabilitySpecs.old_name).toBeUndefined()
	expect(registry.capabilityAliases.old_name).toMatchObject({
		name: 'old_name',
		targetName: 'new_name',
		domain: 'meta',
		deprecated: true,
		hiddenFromSearch: true,
		description: 'Use new_name instead.',
	})
	expect(registry.capabilitySpecs.new_name).toMatchObject({
		source: 'builtin',
		aliases: [
			{
				name: 'old_name',
				deprecated: true,
				hiddenFromSearch: true,
			},
		],
	})

	await expect(
		registry.capabilityHandlers.old_name({}, {
			env: {} as Env,
			callerContext: {
				baseUrl: 'https://example.com',
			},
		} as CapabilityContext),
	).resolves.toEqual({ ok: true })
})
