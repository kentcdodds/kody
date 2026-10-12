import { expect, test } from 'vitest'
import { scanPackageCredentials } from './credential-inventory-scan.ts'

function scan(
	source: string,
	slots?: Parameters<typeof scanPackageCredentials>[0]['slots'],
) {
	return scanPackageCredentials({ files: { 'index.ts': source }, slots })
}

test('counts every placeholder by kind, including ones that match a declared slot', () => {
	const result = scan(
		`
		const a = '{{secret:RESEND_API_KEY}}'
		const b = '{{secret-basic:username=USER,password=PASS}}'
		const c = '{{integration-token:github}}'
		const d = '{{secret/1password:op://vault/item/field}}'
		const e = \`{{secret:\${name}}}\`
		const f = 'help text: {{secret:<name>}}'
		`,
		{
			RESEND_API_KEY: {
				kind: 'secret',
				provider: 'resend',
				description: 'Sends email.',
			},
		},
	)
	expect(result.placeholders).toEqual({
		secret: 1,
		'secret-basic': 1,
		'integration-token': 1,
		vault: 1,
		computed: 1,
	})
	expect(result.references.map((ref) => [ref.nameKind, ref.name])).toEqual([
		['secret', 'RESEND_API_KEY'],
		['secret', 'USER'],
		['secret', 'PASS'],
		['integration', 'github'],
	])
	expect(result.slots).toEqual([
		{ name: 'RESEND_API_KEY', kind: 'secret', provider: 'resend' },
	])
})

test('classifies header, query, path, body, and basic placements', () => {
	const result = scan(`
		const BASE = 'https://api.example.com'
		await fetch(\`\${BASE}/v1/send\`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer {{secret:BEARER_KEY}}',
				'X-Api-Key': '{{secret:HEADER_KEY}}',
				'X-Custom': 'k={{secret:CUSTOM_KEY}};v=1',
				Basic: 'Basic {{secret-basic:username=U,password=P}}',
			},
			body: JSON.stringify({
				token: '{{secret:BODY_KEY}}',
				callback: 'https://cb.example.com/hook?token={{secret:BODY_URL_KEY}}',
			}),
		})
		await fetch('https://api.example.com/v1/items?limit=5&api_key={{secret:QUERY_KEY}}')
		await fetch('https://api.example.com/bot{{secret:PATH_KEY}}/send')
		const headers = new Headers({ 'x-token': 'Token {{secret:NEW_HEADERS_KEY}}' })
		headers.set('X-Set', '{{secret:SET_KEY}}')
		headers.set('X-Wrapped', ('{{secret:WRAPPED_SET_KEY}}' as string))
		const url = new URL('https://api.example.com')
		url.searchParams.set('key', '{{secret:SEARCH_KEY}}')
		const stashed = '{{secret:STASHED_KEY}}'
	`)
	expect(
		Object.fromEntries(
			result.references.map((ref) => [ref.name, ref.placement]),
		),
	).toEqual({
		BEARER_KEY: {
			type: 'header',
			name: 'authorization',
			format: 'Bearer {value}',
		},
		HEADER_KEY: { type: 'header', name: 'x-api-key', format: '{value}' },
		CUSTOM_KEY: { type: 'header-custom' },
		U: { type: 'basic' },
		P: { type: 'basic' },
		BODY_KEY: { type: 'body' },
		BODY_URL_KEY: { type: 'body' },
		QUERY_KEY: { type: 'query', param: 'api_key' },
		PATH_KEY: { type: 'path' },
		NEW_HEADERS_KEY: {
			type: 'header',
			name: 'x-token',
			format: 'Token {value}',
		},
		SET_KEY: { type: 'header', name: 'x-set', format: '{value}' },
		WRAPPED_SET_KEY: {
			type: 'header',
			name: 'x-wrapped',
			format: '{value}',
		},
		SEARCH_KEY: { type: 'query', param: 'key' },
		STASHED_KEY: { type: 'other' },
	})
})

test('keeps literal scopes, skips test files, and reads unparseable modules as text', () => {
	const result = scanPackageCredentials({
		files: {
			'src/index.ts': `const a = '{{secret:PKG_KEY|scope=package}}'`,
			'src/index.test.ts': `const b = '{{secret:FIXTURE}}'`,
			'src/broken.ts': `const c = '{{secret:BROKEN_KEY}}' +++ {`,
			'README.md': '{{secret:DOCS_ONLY}}',
		},
		slots: undefined,
	})
	expect(result.references).toEqual([
		{
			nameKind: 'secret',
			name: 'BROKEN_KEY',
			scope: null,
			placement: { type: 'other' },
		},
		{
			nameKind: 'secret',
			name: 'PKG_KEY',
			scope: 'package',
			placement: { type: 'other' },
		},
	])
	expect(result.unparsedModules).toBe(1)
	expect(result.placeholders.secret).toBe(2)
})
