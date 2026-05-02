import { expect, test } from 'vitest'
import { createSchemaTypeDefinition } from './schema-type-definitions.ts'
import { type CapabilityJsonSchema } from './types.ts'

test('parenthesizes union members when composing allOf intersections', () => {
	const typeDefinition = createSchemaTypeDefinition({
		typeName: 'IntersectedInput',
		jsonSchema: {
			allOf: [
				{
					anyOf: [{ type: 'string' }, { type: 'number' }],
				},
				{
					type: 'object',
					properties: {
						id: { type: 'string' },
					},
					required: ['id'],
				},
			],
		} as CapabilityJsonSchema,
	})

	expect(typeDefinition).toBe(
		'type IntersectedInput = (string | number) & {\n\tid: string\n}',
	)
})

test('preserves JSON Schema descriptions as type comments', () => {
	const typeDefinition = createSchemaTypeDefinition({
		typeName: 'CreateIssueInput',
		jsonSchema: {
			type: 'object',
			description: 'Input for creating an issue.',
			properties: {
				owner: {
					type: 'string',
					description: 'Repository owner.',
				},
				repo: {
					type: 'string',
					description: 'Repository name.\nMay include dashes.',
				},
				body: {
					type: 'string',
					description: 'Issue body with a closing marker */ inside.',
				},
			},
			required: ['owner', 'repo'],
		} as CapabilityJsonSchema,
	})

	expect(typeDefinition).toContain('/** Input for creating an issue. */')
	expect(typeDefinition).toContain('\t/** Repository owner. */\n\towner: string')
	expect(typeDefinition).toContain(
		['\t/**', '\t * Repository name.', '\t * May include dashes.', '\t */'].join(
			'\n',
		),
	)
	expect(typeDefinition).toContain(
		'\t/** Issue body with a closing marker * / inside. */',
	)
	expect(typeDefinition).toContain('\tbody?: string')
})
