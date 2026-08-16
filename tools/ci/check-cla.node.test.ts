import { expect, test } from 'vitest'

import {
	applyIndividualClaSigningComment,
	checkClaIdentities,
	formatClaFailure,
	individualClaSigningPhrase,
	isIndividualClaSigningComment,
	parseClaSignersFile,
	serializeClaSignersFile,
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
				github: 'ExampleSigner',
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
				githubLogin: 'examplesigner',
				name: 'Example Signer',
				email: 'signer@example.com',
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
	expect(formatClaFailure(failing)).toContain(individualClaSigningPhrase)
})

test('CLA signing comment records the commenter once and ignores everything else', () => {
	const empty = signersFile()
	expect(
		isIndividualClaSigningComment(`  ${individualClaSigningPhrase}  `),
	).toBe(true)
	expect(isIndividualClaSigningComment('I agree')).toBe(false)

	const ignored = applyIndividualClaSigningComment({
		file: empty,
		github: 'ExampleSigner',
		signedAt: '2026-08-16',
		comment: 'I agree',
	})
	expect(ignored).toEqual({
		file: empty,
		status: 'ignored',
		reason: 'not_signing_comment',
	})

	const recorded = applyIndividualClaSigningComment({
		file: empty,
		github: 'ExampleSigner',
		signedAt: '2026-08-16',
		comment: individualClaSigningPhrase,
	})
	expect(recorded.status).toBe('recorded')
	if (recorded.status !== 'recorded') {
		throw new Error('expected a new signature')
	}
	expect(recorded.github).toBe('ExampleSigner')
	expect(recorded.file.signers).toEqual([
		{
			github: 'ExampleSigner',
			signedAt: '2026-08-16',
			cla: 'individual',
		},
	])
	expect(
		checkClaIdentities(
			[{ githubLogin: 'examplesigner', name: 'Example', email: null }],
			recorded.file,
		),
	).toEqual({ ok: true })

	const again = applyIndividualClaSigningComment({
		file: recorded.file,
		github: 'examplesigner',
		signedAt: '2026-08-17',
		comment: individualClaSigningPhrase,
	})
	expect(again).toEqual({
		file: recorded.file,
		status: 'already_signed',
		github: 'examplesigner',
	})
	const serialized = serializeClaSignersFile(recorded.file)
	expect(serialized).toContain('"ExampleSigner"')
	expect(serialized.endsWith('\n')).toBe(true)
	expect(parseClaSignersFile(serialized)).toEqual(recorded.file)
	expect(() => parseClaSignersFile('{"version":2}')).toThrow(/version 1/)
	expect(
		applyIndividualClaSigningComment({
			file: empty,
			github: '   ',
			signedAt: '2026-08-16',
			comment: individualClaSigningPhrase,
		}),
	).toEqual({ file: empty, status: 'ignored', reason: 'missing_login' })
})
