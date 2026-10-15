import { expect, test } from 'vitest'
import {
	declareCredentialNeedsCodemod,
	declareCredentialNeedsMessages,
	declaredCredentialSlotDescription,
} from './0013-declare-credential-needs.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		indent,
	)}\n`
}

function transform(source: string, kody: Record<string, unknown> = {}) {
	return declareCredentialNeedsCodemod.transform(
		{ 'package.json': manifest(kody), 'index.ts': source },
		packageContext,
	)
}

function declaredSlots(result: { files: Record<string, string> }) {
	return JSON.parse(result.files['package.json']!).kody.credentials as Record<
		string,
		unknown
	>
}

const slot = { description: declaredCredentialSlotDescription }

test('0013 declares every literal name the fetch gateway fills', () => {
	const result = transform(
		[
			"import { createAuthenticatedFetch, secretHeaders, oauthClientCredentials } from 'kody:runtime'",
			"const TOKEN = 'RESEND_API_KEY'",
			'export default async function run() {',
			"\tconst google = await createAuthenticatedFetch('google')",
			"\tsecretHeaders.basic({ usernameSecret: 'U', passwordSecret: 'P' })",
			"\toauthClientCredentials({ clientIdSecret: 'CID', clientSecretSecret: 'CSECRET' })",
			'\tawait fetch(`https://api.resend.com?key={{secret:${TOKEN}}}`, {',
			"\t\theaders: { authorization: 'Bearer {{integration-token:github}}', x: '{{secret:STRIPE|scope=user}}' },",
			'\t})',
			"\treturn google('https://www.googleapis.com/calendar/v3/users/me')",
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		CID: slot,
		CSECRET: slot,
		P: slot,
		RESEND_API_KEY: slot,
		STRIPE: slot,
		U: slot,
		github: slot,
		google: slot,
	})
})

test('0013 declares literal credential() and credentials() keys, aliases included', () => {
	const result = transform(
		[
			"import { credential as cred, credentials } from 'kody:runtime'",
			"import kody from 'kody:runtime'",
			"const KEY = 'linear'",
			'export default async function run() {',
			"\tawait cred('resend')",
			'\tawait credentials(KEY)',
			"\tawait kody.credential('slack')",
			"\treturn cred.named('legacy')",
			'}',
		].join('\n'),
	)
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		linear: slot,
		resend: slot,
		slack: slot,
	})
})

test('0013 keeps declared slots, secret mounts, and helpers that bypass the gateway', () => {
	const result = transform(
		[
			"import { packageSecrets, secretJwtSign, integrationTokenRefresh } from 'kody:runtime'",
			'export default async function run() {',
			"\tawait packageSecrets.get('mounted')",
			"\tawait secretJwtSign({ private_key_secret_name: 'JWT_KEY' })",
			"\tawait integrationTokenRefresh({ name: 'gmail' })",
			"\treturn fetch('https://x.test', { headers: { a: '{{secret:DECLARED}}', b: '{{secret:REAL_NAME}}' } })",
			'}',
		].join('\n'),
		{
			credentials: { DECLARED: { kind: 'secret', description: 'Owner text.' } },
			secretMounts: { mounted: { name: 'REAL_NAME' } },
		},
	)
	expect(result).toMatchObject({ changed: false, needsManual: [] })
	expect(
		declareCredentialNeedsCodemod.detect(
			{ 'package.json': manifest(), 'index.ts': 'export default 1' },
			packageContext,
		),
	).toEqual([])
})

test('0013 flags what it cannot declare and still declares the rest', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run(input: { key: string; name: string }) {',
			'\tawait credential(input.key)',
			"\tawait fetch('https://x.test', { headers: {",
			'\t\ta: `{{secret:${input.name}}}`,',
			"\t\tb: '{{secret/1password:op://v/i/f}}',",
			"\t\tc: '{{secret:9bad}}',",
			"\t\td: '{{integration-token:MCP_ONLY}}',",
			"\t\te: '{{secret:FINE}}',",
			'\t} })',
			'\treturn [credential].length',
			'}',
		].join('\n'),
		{ credentials: { MCP_ONLY: { kind: 'mcp', description: 'Owner text.' } } },
	)
	expect(result.changed).toBe(true)
	expect(declaredSlots(result)).toEqual({
		FINE: slot,
		MCP_ONLY: { kind: 'mcp', description: 'Owner text.' },
	})
	expect(result.needsManual.map((finding) => finding.message).sort()).toEqual(
		[
			declareCredentialNeedsMessages.computed,
			declareCredentialNeedsMessages.indirectCredential,
			declareCredentialNeedsMessages.invalidKey,
			declareCredentialNeedsMessages.kindMismatch,
			declareCredentialNeedsMessages.vault,
		].sort(),
	)
	expect(
		result.needsManual.every((finding) => finding.path === 'index.ts'),
	).toBe(true)
})

test('0013 leaves undeclared credential() keys in signing or MCP modules for the owner', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			"\tconst signer = await credential('docusign')",
			'\treturn signer.sign?.({})',
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{
			path: 'index.ts',
			message: declareCredentialNeedsMessages.nonFetchCredential,
		},
	])
})

test('0013 keeps manifest indentation, other kody fields, and is idempotent', () => {
	const files = {
		'package.json': manifest(
			{ jobs: { tick: { handler: './tick.ts' } } },
			'  ',
		),
		'index.ts': "export default () => fetch('https://x.test?k={{secret:K}}')",
	}
	const once = declareCredentialNeedsCodemod.transform(files, packageContext)
	expect(once.files['package.json']).toContain('\n  "name"')
	expect(JSON.parse(once.files['package.json']!).kody).toMatchObject({
		jobs: { tick: { handler: './tick.ts' } },
		credentials: { K: slot },
	})
	expect(declareCredentialNeedsCodemod.detect(files, packageContext)).toEqual([
		{ path: 'package.json', message: declareCredentialNeedsMessages.declare },
	])
	const twice = declareCredentialNeedsCodemod.transform(
		once.files,
		packageContext,
	)
	expect(twice).toMatchObject({ changed: false, needsManual: [] })
	expect(
		declareCredentialNeedsCodemod.detect(once.files, packageContext),
	).toEqual([])
})

test('0013 reports an invalid manifest without writing', () => {
	const result = declareCredentialNeedsCodemod.transform(
		{
			'package.json': '{ not json',
			'index.ts': "export default () => '{{secret:K}}'",
		},
		packageContext,
	)
	expect(result).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'package.json',
				message: declareCredentialNeedsMessages.invalidManifest,
			},
		],
	})
})

test('0013 findings never carry credential names', () => {
	const findings = declareCredentialNeedsCodemod.detect(
		{
			'package.json': manifest(),
			'index.ts':
				"export default (n: string) => ['{{secret:SECRET_NAME_123}}', `{{secret:${n}}}`]",
		},
		packageContext,
	)
	expect(findings.length).toBeGreaterThan(0)
	for (const finding of findings) {
		expect(finding.message).not.toContain('SECRET_NAME_123')
	}
})
