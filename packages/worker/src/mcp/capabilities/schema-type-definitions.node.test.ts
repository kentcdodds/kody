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
