import { expect, test } from 'vitest'
import { createSchemaTypeDefinition } from './schema-type-definitions.ts'
import { type CapabilityJsonSchema } from './types.ts'

test('createSchemaTypeDefinition composes intersections and preserves escaped schema comments', () => {
	const intersected = createSchemaTypeDefinition({
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
	expect(intersected).toBe(
		'type IntersectedInput = (string | number) & {\n\tid: string\n}',
	)

	const commented = createSchemaTypeDefinition({
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

	expect(commented).toBe(
		[
			'/** Root description. */',
			'type CreateIssueInput = {',
			'\t/** Owner field. */',
			'\towner: string',
			'\t/**',
			'\t * First line.',
			'\t * Second line.',
			'\t */',
			'\trepo: string',
			'\t/** Closing marker * / should stay escaped. */',
			'\tbody?: string',
			'}',
		].join('\n'),
	)
})
