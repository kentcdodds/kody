import { expect, test } from 'vitest'
import {
	applyUiArtifactParameters,
	normalizeUiArtifactParameters,
} from './ui-artifact-parameters.ts'

test('ui artifact parameters normalize names, apply defaults, and reject invalid caller input', () => {
	const defs = normalizeUiArtifactParameters([
		{
			name: ' owner ',
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
	])

	expect(defs).toEqual([
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
			required: false,
			default: 5,
		},
	])

	expect(() =>
		applyUiArtifactParameters({ definitions: defs, values: { limit: 2 } }),
	).toThrow('Missing required package app parameter: owner.')

	expect(
		applyUiArtifactParameters({ definitions: defs, values: { owner: 'kody' } }),
	).toEqual({
		owner: 'kody',
		limit: 5,
	})

	expect(() =>
		applyUiArtifactParameters({
			definitions: defs,
			values: { owner: 'kody', extra: true },
		}),
	).toThrow('Unknown package app parameter(s): extra.')
})
