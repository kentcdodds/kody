import { expect, test } from 'vitest'
import {
	applySkillParameters,
	buildParameterizedSkillCode,
	normalizeSkillParameters,
} from './skill-parameters.ts'

test('module parameter definitions normalize names, validate inputs, and run parameterized skill code', async () => {
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

	expect(() =>
		applySkillParameters({ definitions, values: { limit: 2 } }),
	).toThrow('Missing required module parameter: owner.')

	expect(() =>
		applySkillParameters({
			definitions,
			values: { owner: 'kody', extra: true },
		}),
	).toThrow('Unknown module parameter(s): extra.')

	const resolved = applySkillParameters({
		definitions,
		values: { owner: 'kody' },
	})
	expect(resolved).toEqual({
		owner: 'kody',
		limit: 5,
	})

	const code = await buildParameterizedSkillCode(
		'async (params) => params.owner',
		resolved,
	)
	const module = Function(`return (${code})`)() as () => Promise<unknown>
	await expect(module()).resolves.toBe('kody')
})
