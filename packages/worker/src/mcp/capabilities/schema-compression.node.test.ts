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

test('compressSchemaForLlm handles nested object schemas', () => {
	const schema = {
		type: 'object',
		properties: {
			repo: {
				type: 'object',
				properties: {
					owner: {
						type: 'string',
						title: 'Owner',
						description: 'owner',
					},
					name: {
						type: 'string',
						description: 'Repository name',
					},
				},
				required: ['owner'],
			},
		},
		required: ['repo'],
	}

	expect(compressSchemaForLlm(schema)).toEqual({
		properties: {
			repo: {
				type: 'object',
				properties: {
					owner: {
						type: 'string',
					},
					name: {
						type: 'string',
						description: 'Repository name',
					},
				},
				required: ['owner'],
			},
		},
		required: ['repo'],
	})
})

test('compressSchemaForLlm compresses array item schemas', () => {
	const schema = {
		type: 'object',
		properties: {
			labels: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: {
							type: 'string',
							description: 'name',
						},
						color: {
							type: 'string',
							description: 'Hex color value.',
						},
					},
					required: ['name'],
				},
			},
		},
	}

	expect(compressSchemaForLlm(schema)).toEqual({
		properties: {
			labels: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: {
							type: 'string',
						},
						color: {
							type: 'string',
							description: 'Hex color value.',
						},
					},
					required: ['name'],
				},
			},
		},
	})
})

test('compressSchemaForLlm handles nullish inputs', () => {
	expect(compressSchemaForLlm(null)).toBeNull()
	expect(compressSchemaForLlm(undefined)).toBeUndefined()
})

test('compressSchemaForLlm compresses composed schemas', () => {
	const schema = {
		type: 'object',
		allOf: [
			{
				type: 'object',
				properties: {
					owner: {
						type: 'string',
						description: 'owner',
					},
				},
				required: ['owner'],
			},
		],
		anyOf: [
			{
				type: 'object',
				properties: {
					repo: {
						type: 'string',
					},
				},
			},
		],
		oneOf: [
			{
				type: 'object',
				properties: {
					org: {
						type: 'string',
						description: 'Organization name.',
					},
				},
			},
		],
		not: {
			type: 'object',
			properties: {
				ignored: {
					type: 'string',
					description: 'ignored',
				},
			},
		},
		if: {
			type: 'object',
			properties: {
				mode: {
					type: 'string',
					description: 'mode',
				},
			},
		},
		then: {
			type: 'object',
			properties: {
				strategy: {
					type: 'string',
					description: 'Release strategy.',
				},
			},
		},
		else: {
			type: 'object',
			properties: {
				reason: {
					type: 'string',
					description: 'reason',
				},
			},
		},
	}

	expect(compressSchemaForLlm(schema)).toEqual({
		allOf: [
			{
				type: 'object',
				properties: {
					owner: {
						type: 'string',
					},
				},
				required: ['owner'],
			},
		],
		anyOf: [
			{
				type: 'object',
				properties: {
					repo: {
						type: 'string',
					},
				},
			},
		],
		oneOf: [
			{
				type: 'object',
				properties: {
					org: {
						type: 'string',
						description: 'Organization name.',
					},
				},
			},
		],
		not: {
			type: 'object',
			properties: {
				ignored: {
					type: 'string',
				},
			},
		},
		if: {
			type: 'object',
			properties: {
				mode: {
					type: 'string',
				},
			},
		},
		then: {
			type: 'object',
			properties: {
				strategy: {
					type: 'string',
					description: 'Release strategy.',
				},
			},
		},
		else: {
			type: 'object',
			properties: {
				reason: {
					type: 'string',
				},
			},
		},
	})
})
