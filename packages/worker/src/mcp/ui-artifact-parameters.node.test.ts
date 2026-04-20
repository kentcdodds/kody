import { expect, test } from 'vitest'
import {
	applyUiArtifactParameters,
	normalizeUiArtifactParameters,
} from './ui-artifact-parameters.ts'

test('normalizeUiArtifactParameters trims names and validates defaults', () => {
	const params = normalizeUiArtifactParameters([
		{
			name: ' owner ',
			description: 'Repo owner.',
			type: 'string',
			required: true,
			default: 'kody',
		},
	])
	expect(params).toEqual([
		{
			name: 'owner',
			description: 'Repo owner.',
			type: 'string',
			required: true,
			default: 'kody',
		},
	])
})

test('applyUiArtifactParameters enforces required and applies defaults', () => {
	const defs = normalizeUiArtifactParameters([
		{
			name: 'owner',
			description: 'Repo owner.',
			type: 'string',
			required: true,
		},
		{
			name: 'limit',
			description: 'Result limit.',
			type: 'number',
			default: 5,
		},
	])!
	expect(() =>
		applyUiArtifactParameters({ definitions: defs, values: { limit: 2 } }),
	).toThrow('Missing required package app parameter: owner.')
	expect(
		applyUiArtifactParameters({ definitions: defs, values: { owner: 'kody' } }),
	).toEqual({
		owner: 'kody',
		limit: 5,
	})
})

test('applyUiArtifactParameters rejects unknown names', () => {
	const defs = normalizeUiArtifactParameters([
		{
			name: 'query',
			description: 'Search query.',
			type: 'string',
			required: true,
		},
	])!
	expect(() =>
		applyUiArtifactParameters({
			definitions: defs,
			values: { query: 'hello', extra: true },
		}),
	).toThrow('Unknown package app parameter(s): extra.')
})
