import { expect, test } from 'vitest'
import {
	listJsonSchemaSubsetProblems,
	listJsonSchemaSubsetValueErrors,
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

	expect(listJsonSchemaSubsetProblems('nope')).toEqual([
		'# must be a JSON object schema.',
	])
	expect(
		listJsonSchemaSubsetProblems({ type: 'object', $ref: '#/defs/x' }),
	).toEqual([expect.stringContaining('unsupported keyword "$ref"')])
	expect(listJsonSchemaSubsetProblems({ type: 'uuid' })).toEqual([
		expect.stringContaining('"uuid" is not supported'),
	])
	expect(
		listJsonSchemaSubsetProblems({
			type: 'object',
			properties: { nested: { pattern: '^a' } },
		}),
	).toEqual([expect.stringContaining('#.properties["nested"]')])
	expect(
		listJsonSchemaSubsetProblems({ type: 'object', additionalProperties: {} }),
	).toEqual([expect.stringContaining('additionalProperties must be a boolean')])
	expect(listJsonSchemaSubsetProblems({ enum: [] })).toEqual([
		expect.stringContaining('enum must be a non-empty array'),
	])
	expect(listJsonSchemaSubsetProblems({ minLength: -1 })).toEqual([
		expect.stringContaining('minLength must be a non-negative integer'),
	])
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

	expect(
		listJsonSchemaSubsetValueErrors(schema, {
			messageId: 'm-1',
			kind: 'created',
			count: 3,
			tags: ['a', 'b'],
		}),
	).toEqual([])

	expect(listJsonSchemaSubsetValueErrors(schema, {})).toEqual([
		'payload is missing required property "messageId".',
	])
	expect(
		listJsonSchemaSubsetValueErrors(schema, { messageId: '', kind: 'nope' }),
	).toEqual([
		'payload.messageId must have at least 1 characters.',
		'payload.kind must be one of "created", "updated".',
	])
	expect(
		listJsonSchemaSubsetValueErrors(schema, { messageId: 'm', count: 3.5 }),
	).toEqual(['payload.count must have type integer.'])
	expect(
		listJsonSchemaSubsetValueErrors(schema, {
			messageId: 'm',
			tags: ['a', 'b', 'c'],
		}),
	).toEqual(['payload.tags must have at most 2 items.'])
	expect(
		listJsonSchemaSubsetValueErrors(schema, { messageId: 'm', tags: [1] }),
	).toEqual(['payload.tags[0] must have type string.'])
	expect(
		listJsonSchemaSubsetValueErrors(schema, { messageId: 'm', extra: true }),
	).toEqual(['payload has unexpected property "extra".'])
	// Missing `properties` means an empty declared set, so
	// additionalProperties: false rejects every key.
	expect(
		listJsonSchemaSubsetValueErrors(
			{ type: 'object', additionalProperties: false },
			{ anything: 1 },
		),
	).toEqual(['payload has unexpected property "anything".'])

	expect(
		listJsonSchemaSubsetValueErrors(
			{ const: { a: 1, b: [2] } },
			{ b: [2], a: 1 },
		),
	).toEqual([])
	expect(listJsonSchemaSubsetValueErrors({ const: 'x' }, 'y')).toEqual([
		'payload must equal the const value "x".',
	])
	expect(
		listJsonSchemaSubsetValueErrors({ type: ['string', 'null'] }, null),
	).toEqual([])
	expect(
		listJsonSchemaSubsetValueErrors({ type: ['string', 'null'] }, 5),
	).toEqual(['payload must have type string | null.'])
})
