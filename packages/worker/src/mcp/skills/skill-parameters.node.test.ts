import { expect, test } from 'vitest'
import {
	applySkillParameters,
	buildParameterizedSkillCode,
	normalizeSkillParameters,
} from './skill-parameters.ts'

test('skill parameter definitions normalize names and resolve one workflow end to end', () => {
	const definitions = normalizeSkillParameters([
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
	])!

	expect(definitions).toEqual([
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
		applySkillParameters({ definitions, values: { limit: 2 } }),
	).toThrow('Missing required skill parameter: owner.')

	expect(() =>
		applySkillParameters({
			definitions,
			values: { owner: 'kody', extra: true },
		}),
	).toThrow('Unknown skill parameter(s): extra.')

	expect(
		applySkillParameters({ definitions, values: { owner: 'kody' } }),
	).toEqual({
		owner: 'kody',
		limit: 5,
	})
})

test('buildParameterizedSkillCode applies params through the generated wrapper', async () => {
	const code = await buildParameterizedSkillCode(
		'async (params) => params.owner',
		{ owner: 'kody' },
	)
	const skill = Function(`return (${code})`)() as () => Promise<unknown>
	await expect(skill()).resolves.toBe('kody')
})
