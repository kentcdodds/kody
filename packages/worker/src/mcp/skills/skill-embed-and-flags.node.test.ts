import { expect, test } from 'vitest'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { slugifySkillCollectionName } from './skill-collections.ts'
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
	secret_delete: {
		name: 'secret_delete',
		domain: capabilityDomainNames.secrets,
		description: 'Delete a stored secret.',
		keywords: ['secret'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputFields: ['name'],
		requiredInputFields: ['name'],
		outputFields: [],
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

test('buildSkillEmbedText keeps inferred capability names lightweight', () => {
	const parameters: Array<SkillParameterDefinition> = [
		{
			name: 'owner',
			description: 'GitHub repo owner.',
			type: 'string',
			required: true,
		},
	]
	const text = buildSkillEmbedText({
		skillName: 'launch-cursor-cloud-agent',
		title: 't',
		description: 'd',
		collectionName: 'GitHub automation',
		collectionSlug: 'github-automation',
		keywords: ['k'],
		searchText: null,
		inferredCapabilities: ['ui_save_app'],
		parameters,
		specs: fakeSpecs,
	})
	const lines = text.split('\n')
	expect(lines).toEqual(
		expect.arrayContaining([
			'name launch-cursor-cloud-agent',
			'launch cursor cloud agent',
			't',
			'd',
			'collection GitHub automation',
			'github-automation',
			'k',
			'meta',
			'skill',
			'owner: GitHub repo owner. (string)',
			'inferred capabilities: ui_save_app',
		]),
	)
	expect(text).not.toContain('Save a generated UI artifact.')
	expect(text).not.toContain('title description keywords source app_id')
})

test('validateSkillSaveFlags rejects read_only with destructive inferred set', () => {
	const derived = deriveTrustFlags(['secret_delete'], fakeSpecs, false)
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

test('slugifySkillCollectionName generates deterministic fallback for non-latin names', () => {
	const first = slugifySkillCollectionName('日本語')
	const second = slugifySkillCollectionName('日本語')
	const other = slugifySkillCollectionName('한국어')

	expect(first).toMatch(/^col-[a-z0-9]+$/)
	expect(first).toBe(second)
	expect(other).not.toBe(first)
})
