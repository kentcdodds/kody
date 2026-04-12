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

test('defineDomain rejects capability registered under wrong domain id', () => {
	const capability = defineDomainCapability(capabilityDomainNames.apps, {
		name: 'orphan',
		description: 'test',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.coding,
			description: 'coding bucket',
			capabilities: [capability],
		}),
	).toThrow(/registered under domain/)
})

test('buildCapabilityRegistry rejects duplicate capability names across domains', () => {
	const appsSide = defineDomainCapability(capabilityDomainNames.apps, {
		name: 'collision',
		description: 'a',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	const codingSide = defineDomainCapability(capabilityDomainNames.coding, {
		name: 'collision',
		description: 'b',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		buildCapabilityRegistry([
			defineDomain({
				name: capabilityDomainNames.apps,
				description: 'a',
				capabilities: [appsSide],
			}),
			defineDomain({
				name: capabilityDomainNames.coding,
				description: 'c',
				capabilities: [codingSide],
			}),
		]),
	).toThrow(/Duplicate capability names/)
})

test('buildCapabilityRegistry rejects duplicate domain registration', () => {
	const appsDomain = defineDomain({
		name: capabilityDomainNames.apps,
		description: 'a',
		capabilities: [
			defineDomainCapability(capabilityDomainNames.apps, {
				name: 'only',
				description: 'o',
				inputSchema: z.object({}),
				handler: noopHandler,
			}),
		],
	})
	expect(() => buildCapabilityRegistry([appsDomain, appsDomain])).toThrow(
		/Duplicate domain registration/,
	)
})

test('builtin capability domains include scheduler', async () => {
	const { builtinDomains } = await import('./builtin-domains.ts')
	expect(builtinDomains.some((domain) => domain.name === 'scheduler')).toBe(true)
	const schedulerDomain = builtinDomains.find(
		(domain) => domain.name === 'scheduler',
	)
	expect(
		schedulerDomain?.capabilities.map((capability) => capability.name),
	).toEqual([
		'scheduler_upsert',
		'scheduler_list',
		'scheduler_get',
		'scheduler_delete',
		'scheduler_run_now',
	])
})

test('defineDomain rejects duplicate capability names within one domain', () => {
	const one = defineDomainCapability(capabilityDomainNames.apps, {
		name: 'dup',
		description: '1',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	const two = defineDomainCapability(capabilityDomainNames.apps, {
		name: 'dup',
		description: '2',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.apps,
			description: 'a',
			capabilities: [one, two],
		}),
	).toThrow(/Duplicate capability .* in domain/)
})
