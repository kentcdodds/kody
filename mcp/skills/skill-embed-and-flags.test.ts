import { expect, test } from 'bun:test'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import {
	buildSkillEmbedText,
	mergeInferredCapabilityNames,
	validateSkillSaveFlags,
	deriveTrustFlags,
} from './skill-embed-and-flags.ts'

const fakeSpecs: Record<string, CapabilitySpec> = {
	do_math: {
		name: 'do_math',
		domain: capabilityDomainNames.math,
		description: 'Arithmetic on two numbers.',
		keywords: ['arithmetic', 'add'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputFields: ['left', 'right', 'operator'],
		requiredInputFields: ['left', 'right', 'operator'],
		outputFields: ['result'],
		inputSchema: {},
	},
	github_rest: {
		name: 'github_rest',
		domain: capabilityDomainNames.coding,
		description: 'GitHub REST.',
		keywords: ['github'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputFields: ['method', 'path'],
		requiredInputFields: ['method', 'path'],
		outputFields: ['status', 'body'],
		inputSchema: {},
	},
}

test('mergeInferredCapabilityNames splits unknown names', () => {
	const { merged, unknownNames } = mergeInferredCapabilityNames({
		astStaticNames: ['do_math', 'nope'],
		usesCapabilities: undefined,
		specs: fakeSpecs,
	})
	expect(unknownNames).toContain('nope')
	expect(merged).toEqual(['do_math'])
})

test('buildSkillEmbedText includes denormalized capability text', () => {
	const text = buildSkillEmbedText({
		title: 't',
		description: 'd',
		keywords: ['k'],
		searchText: null,
		inferredCapabilities: ['do_math'],
		specs: fakeSpecs,
	})
	expect(text).toContain('do_math')
	expect(text.toLowerCase()).toContain('arithmetic')
})

test('validateSkillSaveFlags rejects read_only with destructive inferred set', () => {
	const derived = deriveTrustFlags(['github_rest'], fakeSpecs, false)
	expect(derived.destructiveDerived).toBe(true)
	const v = validateSkillSaveFlags({
		agentReadOnly: true,
		agentDestructive: true,
		agentIdempotent: false,
		derived,
		inferencePartial: false,
		inferredCount: 1,
	})
	expect(v.ok).toBe(false)
})
