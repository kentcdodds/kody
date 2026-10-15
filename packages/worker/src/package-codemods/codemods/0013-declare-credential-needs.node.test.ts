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

test('0013 leaves undeclared credential() keys for the owner and accepts declared ones', () => {
	const source = [
		"import { credential as cred, credentials } from 'kody:runtime'",
		"import kody from 'kody:runtime'",
		"const KEY = 'linear'",
		'export default async function run() {',
		"\tawait cred('resend')",
		'\tawait credentials(KEY)',
		"\tawait kody.credential('slack')",
		"\tconst signer = await cred('docusign')",
		'\tawait signer.sign?.({})',
		"\treturn cred.named('legacy')",
		'}',
	].join('\n')
	expect(transform(source)).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'index.ts',
				message: declareCredentialNeedsMessages.undeclaredCredentialKey,
			},
		],
	})
	const declared = { description: 'Owner text.' }
	expect(
		transform(source, {
			credentials: {
				docusign: { kind: 'keypair', description: 'Owner text.' },
				linear: declared,
				resend: declared,
				slack: declared,
			},
		}),
	).toMatchObject({ changed: false, needsManual: [] })
})

test('0013 does not read a kody.credential member as passing credential around', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			"import kody from 'kody:runtime'",
			'export default async function run() {',
			"\tawait credential('resend')",
			"\treturn { credential: await kody.credential('resend') }",
			'}',
		].join('\n'),
		{ credentials: { resend: { description: 'Owner text.' } } },
	)
	expect(result).toMatchObject({ changed: false, needsManual: [] })
})

test('0013 keeps declared slots and helpers that bypass the gateway, and declares mounted names', () => {
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
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		DECLARED: { kind: 'secret', description: 'Owner text.' },
		REAL_NAME: slot,
	})
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

test('0013 reads a nested package from its source root', () => {
	const files = {
		'package.json': '{ "name": "repo-root", "private": true }\n',
		'packages/demo/package.json': manifest(),
		'packages/demo/index.ts':
			"export default () => fetch('https://x.test?k={{secret:K}}')",
		'packages/other/index.ts':
			"export default () => fetch('https://x.test?k={{secret:OTHER}}')",
	}
	const nestedContext = {
		...packageContext,
		manifestPath: 'packages/demo/package.json',
		sourceRoot: '/packages/demo/',
	}
	const result = declareCredentialNeedsCodemod.transform(files, nestedContext)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['packages/demo/package.json'],
		needsManual: [],
	})
	expect(result.files['package.json']).toBe(files['package.json'])
	expect(
		JSON.parse(result.files['packages/demo/package.json']!).kody.credentials,
	).toEqual({ K: slot })
	const rootKeyed = declareCredentialNeedsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': files['packages/demo/index.ts'],
		},
		nestedContext,
	)
	expect(rootKeyed.changedPaths).toEqual(['package.json'])
	expect(declaredSlots(rootKeyed)).toEqual({ K: slot })
	const sourceRelativeManifest = declareCredentialNeedsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': files['packages/demo/index.ts'],
		},
		{ ...nestedContext, manifestPath: 'package.json' },
	)
	expect(sourceRelativeManifest.changedPaths).toEqual(['package.json'])
	expect(declaredSlots(sourceRelativeManifest)).toEqual({ K: slot })
})

test('0013 does not declare names read from a module it cannot parse', () => {
	const result = transform(
		[
			"// createAuthenticatedFetch('commented') is not a call",
			'export default async function run( {',
		].join('\n'),
	)
	expect(result).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'index.ts',
				message: declareCredentialNeedsMessages.unparsedModule,
			},
		],
	})
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
