import { expect, test } from 'vitest'
import {
	listJsonSchemaSubsetProblems,
	listJsonSchemaSubsetValueErrors,
	type JsonSchemaSubset,
} from './json-schema-subset.ts'

test('listJsonSchemaSubsetProblems accepts the supported subset and rejects unsupported shapes', () => {
	expect(
		listJsonSchemaSubsetProblems({
			type: 'object',
			description: 'A Discord message event payload.',
			properties: {
				messageId: { type: 'string', minLength: 1 },
				channelId: { type: 'string' },
				kind: { enum: ['created', 'updated'] },
				attachments: {
					type: 'array',
					maxItems: 10,
					items: { type: 'object', properties: { url: { type: 'string' } } },
				},
				priority: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
			},
			required: ['messageId', 'channelId'],
			additionalProperties: false,
		}),
	).toEqual([])

	const cases: Array<[unknown, string]> = [
		['nope', '# must be a JSON object schema.'],
		[{ type: 'object', $ref: '#/defs/x' }, 'unsupported keyword "$ref"'],
		[{ type: 'uuid' }, '"uuid" is not supported'],
		[
			{ type: 'object', properties: { nested: { pattern: '^a' } } },
			'#.properties["nested"]',
		],
		[
			{ type: 'object', additionalProperties: {} },
			'additionalProperties must be a boolean',
		],
		[{ enum: [] }, 'enum must be a non-empty array'],
		[{ minLength: -1 }, 'minLength must be a non-negative integer'],
	]
	expect(cases.map(([schema]) => listJsonSchemaSubsetProblems(schema))).toEqual(
		cases.map(([, problem]) => [expect.stringContaining(problem)]),
	)
})

test('listJsonSchemaSubsetValueErrors validates values, const, and union types', () => {
	const schema = {
		type: 'object',
		properties: {
			messageId: { type: 'string', minLength: 1 },
			kind: { enum: ['created', 'updated'] },
			count: { type: 'integer', minimum: 0, maximum: 10 },
			tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
		},
		required: ['messageId'],
		additionalProperties: false,
	}

	const cases: Array<
		[schema: JsonSchemaSubset, value: unknown, errors: string[]]
	> = [
		[
			schema,
			{ messageId: 'm-1', kind: 'created', count: 3, tags: ['a', 'b'] },
			[],
		],
		[schema, {}, ['payload is missing required property "messageId".']],
		[
			schema,
			{ messageId: '', kind: 'nope' },
			[
				'payload.messageId must have at least 1 characters.',
				'payload.kind must be one of "created", "updated".',
			],
		],
		[
			schema,
			{ messageId: 'm', count: 3.5 },
			['payload.count must have type integer.'],
		],
		[
			schema,
			{ messageId: 'm', tags: ['a', 'b', 'c'] },
			['payload.tags must have at most 2 items.'],
		],
		[
			schema,
			{ messageId: 'm', tags: [1] },
			['payload.tags[0] must have type string.'],
		],
		[
			schema,
			{ messageId: 'm', extra: true },
			['payload has unexpected property "extra".'],
		],
		// Missing `properties` means an empty declared set, so
		// additionalProperties: false rejects every key.
		[
			{ type: 'object', additionalProperties: false },
			{ anything: 1 },
			['payload has unexpected property "anything".'],
		],
		[{ const: { a: 1, b: [2] } }, { b: [2], a: 1 }, []],
		[{ const: 'x' }, 'y', ['payload must equal the const value "x".']],
		[{ type: ['string', 'null'] }, null, []],
		[
			{ type: ['string', 'null'] },
			5,
			['payload must have type string | null.'],
		],
	]
	expect(
		cases.map(([caseSchema, value]) =>
			listJsonSchemaSubsetValueErrors(caseSchema, value),
		),
	).toEqual(cases.map(([, , errors]) => errors))
})
