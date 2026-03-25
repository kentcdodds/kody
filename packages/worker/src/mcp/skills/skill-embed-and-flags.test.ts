import { expect, test } from 'vitest'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import {
	buildSkillEmbedText,
	mergeInferredCapabilityNames,
	validateSkillSaveFlags,
	deriveTrustFlags,
} from './skill-embed-and-flags.ts'
import { type SkillParameterDefinition } from './skill-parameters.ts'

const fakeSpecs: Record<string, CapabilitySpec> = {
	ui_save_app: {
		name: 'ui_save_app',
		domain: capabilityDomainNames.apps,
		description: 'Save a generated UI artifact.',
		keywords: ['app', 'ui', 'artifact'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputFields: ['title', 'description', 'keywords', 'source'],
		requiredInputFields: ['title', 'description', 'keywords', 'source'],
		outputFields: ['app_id'],
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
		astStaticNames: ['ui_save_app', 'nope'],
		usesCapabilities: undefined,
		specs: fakeSpecs,
	})
	expect(unknownNames).toContain('nope')
	expect(merged).toEqual(['ui_save_app'])
})

test('buildSkillEmbedText includes denormalized capability text', () => {
	const parameters: Array<SkillParameterDefinition> = [
		{
			name: 'owner',
			description: 'GitHub repo owner.',
			type: 'string',
			required: true,
		},
	]
	const text = buildSkillEmbedText({
		title: 't',
		description: 'd',
		keywords: ['k'],
		searchText: null,
		inferredCapabilities: ['ui_save_app'],
		parameters,
		specs: fakeSpecs,
	})
	expect(text).toContain('ui_save_app')
	expect(text).toContain('owner')
	expect(text.toLowerCase()).toContain('generated ui artifact')
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
