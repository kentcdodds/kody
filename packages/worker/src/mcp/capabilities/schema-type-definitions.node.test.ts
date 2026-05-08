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
			description: 'Root description.',
			properties: {
				owner: {
					type: 'string',
					description: 'Owner field.',
				},
				repo: {
					type: 'string',
					description: 'First line.\nSecond line.',
				},
				body: {
					type: 'string',
					description: 'Closing marker */ should stay escaped.',
				},
			},
			required: ['owner', 'repo'],
		} as CapabilityJsonSchema,
	})

	expect(typeDefinition).toContain('/** Root description. */')
	expect(typeDefinition).toContain('\t/** Owner field. */\n\towner: string')
	expect(typeDefinition).toContain(
		['\t/**', '\t * First line.', '\t * Second line.', '\t */'].join('\n'),
	)
	expect(typeDefinition).toContain('Closing marker * / should stay escaped.')
	expect(typeDefinition).not.toContain('Closing marker */ should stay escaped.')
	expect(typeDefinition).toContain('\tbody?: string')
})
