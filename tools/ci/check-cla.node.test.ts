import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import {
	checkClaIdentities,
	formatClaFailure,
	parseClaSignersFile,
	type ClaSignersFile,
} from './check-cla.ts'

function signersFile(overrides: Partial<ClaSignersFile> = {}): ClaSignersFile {
	return {
		version: 1,
		document: 'docs/legal/individual-cla.md',
		allowlist: {
			github: ['kentcdodds', 'kody-bot', 'cursoragent'],
			email: ['me@kentcdodds.com', 'me+github@kentcdodds.com'],
		},
		signers: [],
		...overrides,
	}
}

test('CLA check allowlists the Licensor, bots, signed humans, and rejects everyone else', () => {
	const file = signersFile({
		signers: [
			{
				github: 'VojtaHolik',
				signedAt: '2026-08-16',
				cla: 'individual',
			},
		],
	})

	const passing = checkClaIdentities(
		[
			{ githubLogin: 'kentcdodds', name: 'Kent', email: null },
			{ githubLogin: 'kody-bot', name: 'Kody', email: null },
			{
				githubLogin: 'cursoragent',
				name: 'Cursor Agent',
				email: 'cursoragent@cursor.com',
			},
			{
				githubLogin: 'cursor[bot]',
				name: 'cursor[bot]',
				email: null,
			},
			{
				githubLogin: 'app/imgbot',
				name: 'ImgBot',
				email: null,
			},
			{
				githubLogin: null,
				name: 'Kent C. Dodds',
				email: 'me+github@kentcdodds.com',
			},
			{
				githubLogin: 'vojtaholik',
				name: 'Vojta Holik',
				email: 'vojta@egghead.io',
			},
		],
		file,
	)
	expect(passing).toEqual({ ok: true })

	const failing = checkClaIdentities(
		[
			{
				githubLogin: 'kentcdodds',
				name: 'Kent',
				email: null,
			},
			{
				githubLogin: 'mirkosalvato1-ctrl',
				name: 'Mirko',
				email: 'mirkosalvato1@gmail.com',
			},
			{
				githubLogin: null,
				name: 'Someone',
				email: 'someone@example.com',
			},
		],
		file,
	)
	expect(failing.ok).toBe(false)
	if (failing.ok) {
		throw new Error('expected missing signatures')
	}
	expect(failing.missing.map((entry) => entry.reason)).toEqual([
		'@mirkosalvato1-ctrl has not signed the CLA',
		'someone@example.com has no GitHub login and is not a Licensor email',
	])
	expect(formatClaFailure(failing)).toContain(
		'I have read the CLA and I hereby sign the CLA',
	)
})

test('CLA signers file parser rejects the wrong version and accepts the repo file', () => {
	expect(() => parseClaSignersFile('{"version":2}')).toThrow(/version 1/)
	const parsed = parseClaSignersFile(
		readFileSync('.github/cla-signers.json', 'utf8'),
	)
	expect(parsed.allowlist.github).toEqual([
		'kentcdodds',
		'kody-bot',
		'cursoragent',
	])
	expect(parsed.allowlist.email).toEqual([
		'me@kentcdodds.com',
		'me+github@kentcdodds.com',
	])
	expect(parsed.signers).toEqual([])
	expect(
		checkClaIdentities(
			[
				{
					githubLogin: 'kentcdodds',
					name: 'kentcdodds',
					email: null,
				},
				{
					githubLogin: 'cursoragent',
					name: 'Cursor Agent',
					email: 'cursoragent@cursor.com',
				},
			],
			parsed,
		),
	).toEqual({ ok: true })
	expect(
		checkClaIdentities(
			[
				{
					githubLogin: null,
					name: 'Cursor Agent',
					email: 'cursoragent@cursor.com',
				},
				{
					githubLogin: 'mirkosalvato1-ctrl',
					name: 'Mirko',
					email: 'cursoragent@cursor.com',
				},
			],
			parsed,
		),
	).toEqual({
		ok: false,
		missing: [
			{
				identity: {
					githubLogin: null,
					name: 'Cursor Agent',
					email: 'cursoragent@cursor.com',
				},
				reason:
					'cursoragent@cursor.com has no GitHub login and is not a Licensor email',
			},
			{
				identity: {
					githubLogin: 'mirkosalvato1-ctrl',
					name: 'Mirko',
					email: 'cursoragent@cursor.com',
				},
				reason: '@mirkosalvato1-ctrl has not signed the CLA',
			},
		],
	})
})
