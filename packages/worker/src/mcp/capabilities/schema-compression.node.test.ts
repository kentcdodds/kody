import { expect, test } from 'vitest'
import { compressSchemaForLlm } from './schema-compression.ts'

test('compressSchemaForLlm removes redundant metadata', () => {
	const schema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		additionalProperties: false,
		properties: {
			userId: {
				type: 'string',
				title: 'userId',
				description: 'User ID',
				format: 'uuid',
			},
			repo: {
				type: 'string',
				description: 'Repository name',
			},
			team: {
				type: 'string',
				description: 'team',
			},
		},
		required: ['userId', 'repo'],
	}

	const compressed = compressSchemaForLlm(schema)

	expect(compressed).toEqual({
		properties: {
			userId: {
				type: 'string',
				format: 'uuid',
			},
			repo: {
				type: 'string',
				description: 'Repository name',
			},
			team: {
				type: 'string',
			},
		},
		required: ['userId', 'repo'],
	})
})

test('compressSchemaForLlm can keep root type when requested', () => {
	const schema = {
		type: 'object',
		properties: {
			enabled: {
				type: 'boolean',
				description: 'Enable the feature.',
			},
		},
	}

	expect(
		compressSchemaForLlm(schema, { stripRootObjectType: false }),
	).toEqual({
		type: 'object',
		properties: {
			enabled: {
				type: 'boolean',
				description: 'Enable the feature.',
			},
		},
	})
})
