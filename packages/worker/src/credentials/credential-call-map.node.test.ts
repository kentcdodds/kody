import { expect, test } from 'vitest'
import { z } from 'zod'
import {
	credentialCallMapSchema,
	normalizeCredentialCallMap,
} from './credential-call-map.ts'

test('a call map parses names, scoped picks, and lists into picks by key', () => {
	const parsed = credentialCallMapSchema.parse({
		github: 'work',
		google: ['work', { name: 'personal', scope: 'personal' }],
		MAIL_KEY: [],
		'1password': 'vault',
	})
	expect(normalizeCredentialCallMap(parsed)).toEqual(
		new Map([
			['github', [{ name: 'work', scope: null }]],
			[
				'google',
				[
					{ name: 'work', scope: null },
					{ name: 'personal', scope: 'personal' },
				],
			],
			['MAIL_KEY', []],
			['1password', [{ name: 'vault', scope: null }]],
		]),
	)
	expect(normalizeCredentialCallMap({})).toBeNull()
})

test('credentials object pick advertises name and scope field descriptions', () => {
	const schema = z.toJSONSchema(credentialCallMapSchema) as {
		additionalProperties?: {
			anyOf?: Array<{
				anyOf?: Array<{
					properties?: {
						name?: { description?: string }
						scope?: { description?: string }
					}
				}>
			}>
		}
	}
	const objectBranch = schema.additionalProperties?.anyOf
		?.flatMap((branch) => branch.anyOf ?? [])
		.find((branch) => branch.properties?.name && branch.properties?.scope)
	expect(objectBranch?.properties?.name?.description).toMatch(
		/Credential name/i,
	)
	expect(objectBranch?.properties?.name?.description).not.toMatch(/secret/i)
	expect(objectBranch?.properties?.scope?.description).toMatch(
		/org credential and a personal credential/i,
	)
	expect(objectBranch?.properties?.scope?.description).not.toMatch(/secret/i)
})

test('a call map refuses keys that could collide once trimmed', () => {
	for (const key of [' MAIL', 'MAIL ', '', 'a b', '_x']) {
		expect(
			credentialCallMapSchema.safeParse(JSON.parse(`{"${key}": "work"}`))
				.success,
		).toBe(false)
	}
	expect(
		credentialCallMapSchema.safeParse({ github: { name: 'x', scope: 'team' } })
			.success,
	).toBe(false)
})
