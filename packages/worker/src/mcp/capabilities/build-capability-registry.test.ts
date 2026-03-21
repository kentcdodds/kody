/// <reference types="bun" />
import { expect, test } from 'bun:test'
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
	const capability = defineDomainCapability(capabilityDomainNames.math, {
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
	const mathSide = defineDomainCapability(capabilityDomainNames.math, {
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
				name: capabilityDomainNames.math,
				description: 'm',
				capabilities: [mathSide],
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
	const mathDomain = defineDomain({
		name: capabilityDomainNames.math,
		description: 'm',
		capabilities: [
			defineDomainCapability(capabilityDomainNames.math, {
				name: 'only',
				description: 'o',
				inputSchema: z.object({}),
				handler: noopHandler,
			}),
		],
	})
	expect(() => buildCapabilityRegistry([mathDomain, mathDomain])).toThrow(
		/Duplicate domain registration/,
	)
})

test('defineDomain rejects duplicate capability names within one domain', () => {
	const one = defineDomainCapability(capabilityDomainNames.math, {
		name: 'dup',
		description: '1',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	const two = defineDomainCapability(capabilityDomainNames.math, {
		name: 'dup',
		description: '2',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.math,
			description: 'm',
			capabilities: [one, two],
		}),
	).toThrow(/Duplicate capability .* in domain/)
})
