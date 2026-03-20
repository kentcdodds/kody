import { expect, test } from 'bun:test'
import {
	applySkillParameters,
	buildParameterizedSkillCode,
	normalizeSkillParameters,
} from './skill-parameters.ts'

test('normalizeSkillParameters trims names and validates defaults', () => {
	const params = normalizeSkillParameters([
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

test('applySkillParameters enforces required and applies defaults', () => {
	const defs = normalizeSkillParameters([
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
		applySkillParameters({ definitions: defs, values: { limit: 2 } }),
	).toThrow('Missing required skill parameter: owner.')
	expect(applySkillParameters({ definitions: defs, values: { owner: 'kody' } })).toEqual({
		owner: 'kody',
		limit: 5,
	})
})

test('applySkillParameters rejects unknown names', () => {
	const defs = normalizeSkillParameters([
		{
			name: 'query',
			description: 'Search query.',
			type: 'string',
			required: true,
		},
	])!
	expect(() =>
		applySkillParameters({
			definitions: defs,
			values: { query: 'hello', extra: true },
		}),
	).toThrow('Unknown skill parameter(s): extra.')
})

test('buildParameterizedSkillCode injects params', async () => {
	const code = await buildParameterizedSkillCode(
		'async (params) => params.owner',
		{ owner: 'kody' },
	)
	expect(code).toContain('const params = {"owner":"kody"};')
	expect(code).toContain('return await skill(params);')
})
