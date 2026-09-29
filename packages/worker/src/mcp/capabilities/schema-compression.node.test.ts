import { expect, test } from 'vitest'
import { compressSchemaForLlm } from './schema-compression.ts'

function makeSchema(compressed: boolean) {
	const redundant = <T extends Record<string, unknown>>(fields: T) =>
		compressed ? {} : fields
	const string = (description?: string) => ({
		type: 'string',
		...redundant(description ? { description } : {}),
	})
	const described = (description: string) => ({ type: 'string', description })
	const object = (properties: Record<string, unknown>) => ({
		type: 'object',
		properties,
	})
	return {
		...redundant({
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			additionalProperties: false,
		}),
		properties: {
			userId: {
				type: 'string',
				...redundant({ title: 'userId', description: 'User ID' }),
				format: 'uuid',
			},
			repo: {
				...object({
					owner: { ...string('owner'), ...redundant({ title: 'Owner' }) },
					name: described('Repository name'),
				}),
				required: ['owner'],
			},
			labels: {
				type: 'array',
				items: {
					...object({
						name: string('name'),
						color: described('Hex color value.'),
					}),
					required: ['name'],
				},
			},
			team: string('team'),
		},
		required: ['userId', 'repo'],
		allOf: [{ ...object({ owner: string('owner') }), required: ['owner'] }],
		anyOf: [object({ repo: string() })],
		oneOf: [object({ org: described('Organization name.') })],
		not: object({ ignored: string('ignored') }),
		if: object({ mode: string('mode') }),
		// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword, not a thenable
		then: object({ strategy: described('Release strategy.') }),
		else: object({ reason: string('reason') }),
	}
}

test('compressSchemaForLlm strips redundant metadata across object, array, and composed schemas', () => {
	expect(compressSchemaForLlm(makeSchema(false))).toEqual(makeSchema(true))

	const enabledSchema = {
		type: 'object',
		properties: {
			enabled: { type: 'boolean', description: 'Enable the feature.' },
		},
	}
	expect(
		compressSchemaForLlm(enabledSchema, { stripRootObjectType: false }),
	).toEqual(enabledSchema)
	expect(compressSchemaForLlm(null)).toBeNull()
	expect(compressSchemaForLlm(undefined)).toBeUndefined()
})
