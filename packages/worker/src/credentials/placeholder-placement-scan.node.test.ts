import { expect, test } from 'vitest'
import {
	describeMisplacedSecretPlaceholder,
	findSecretPlaceholdersOutsideHeaders,
} from './placeholder-placement-scan.ts'

test('finds placeholders that provably land in a URL, query, or body, with line and slot', () => {
	const findings = findSecretPlaceholdersOutsideHeaders({
		'src/index.ts': `const base = 'https://api.example.com'
export default async function main(input: { id: string }) {
	await fetch(\`\${base}/v1?key={{secret:queryKey}}\`)
	await fetch('https://api.example.com/v1', {
		method: 'POST',
		headers: { Authorization: 'Bearer {{secret:headerToken}}' },
		body: JSON.stringify({ user: '{{secret:clerkReviewUserId}}' }),
	})
	await fetch('https://api.example.com/form', {
		method: 'POST',
		body: new URLSearchParams({ token: '{{integration-token:github}}' }),
	})
	await fetch('https://api.example.com/basic', {
		body: '{{secret-basic:username=apiUser,password=apiPass}}',
	})
	await fetch('https://api.example.com/computed', {
		body: \`{{secret:\${input.id}}}\`,
	})
	return new Headers({ 'x-token': '{{secret:headersCtor}}' })
}
`,
		'src/index.test.ts': `fetch('https://x.test', { body: '{{secret:fixture}}' })`,
	})
	expect(findings).toEqual([
		{ path: 'src/index.ts', line: 3, slot: 'queryKey', location: 'url' },
		{
			path: 'src/index.ts',
			line: 7,
			slot: 'clerkReviewUserId',
			location: 'body',
		},
		{ path: 'src/index.ts', line: 11, slot: 'github', location: 'body' },
		{ path: 'src/index.ts', line: 14, slot: 'apiUser', location: 'body' },
		{ path: 'src/index.ts', line: 17, slot: null, location: 'body' },
	])
	expect(describeMisplacedSecretPlaceholder(findings[1]!)).toBe(
		'"src/index.ts" line 7 puts slot "clerkReviewUserId" in the request body',
	)
	expect(describeMisplacedSecretPlaceholder(findings[4]!)).toBe(
		'"src/index.ts" line 17 puts a secret placeholder in the request body',
	)
})

test('skips prose placeholders, opted-out modules, and unparseable modules', () => {
	expect(
		findSecretPlaceholdersOutsideHeaders({
			'src/prose.ts': `export default () => fetch('https://x.test', { body: 'use {{secret:<name>}}' })`,
			'src/quote.ts': `export default () => fetch('https://x.test', {
	headers: { 'x-kody-secret-resolution': 'headers-only' },
	body: 'Docs: {{secret:apiToken}}',
})`,
			'src/broken.ts': `export default ( => fetch('https://x.test', { body: '{{secret:a}}' })`,
			'README.md': `fetch('https://x.test', { body: '{{secret:a}}' })`,
		}),
	).toEqual([])
})

test('reads the opt-out per fetch, resolves constants at request sites, and ignores strings no request uses', () => {
	const findings = findSecretPlaceholdersOutsideHeaders({
		'src/tokens.ts': `export const QUERY_URL = 'https://api.example.com/?key={{secret:importedKey}}'`,
		'src/index.ts': `import { QUERY_URL } from './tokens.ts'
const BODY_TOKEN = '{{secret:bodyToken}}'
export const example = 'https://api.example.com/?key={{secret:docsOnly}}'
export const logged = JSON.stringify({ note: '{{secret:loggedOnly}}' })
export default async function main(options: RequestInit) {
	await fetch('https://docs.example.com', {
		headers: { 'x-kody-secret-resolution': 'off' },
		body: 'Docs: {{secret:quoted}}',
	})
	await fetch('https://api.example.com/?key={{secret:notOptedOut}}')
	await fetch('https://api.example.com/forward', {
		method: 'POST',
		body: JSON.stringify({ headers: { Authorization: 'Bearer {{secret:payloadHeader}}' } }),
	})
	await fetch('https://api.example.com/const', { method: 'POST', body: BODY_TOKEN })
	await fetch(QUERY_URL)
	await fetch('https://api.example.com/headers-only', {
		headers: { 'X-Kody-Secret-Resolution': 'headers-only' },
		body: 'Docs: {{secret:quotedBody}}',
	})
	await fetch('https://api.example.com/v1', {
		headers: { Authorization: 'Bearer {{secret:headerToken}}' },
	})
}
`,
	})
	expect(findings).toEqual([
		{ path: 'src/index.ts', line: 10, slot: 'notOptedOut', location: 'url' },
		{ path: 'src/index.ts', line: 13, slot: 'payloadHeader', location: 'body' },
		{ path: 'src/index.ts', line: 15, slot: 'bodyToken', location: 'body' },
		{ path: 'src/index.ts', line: 16, slot: 'importedKey', location: 'url' },
	])
})

test('a module that mentions the opt-out exempts requests whose options are not literal', () => {
	expect(
		findSecretPlaceholdersOutsideHeaders({
			'src/index.ts': `const quoting = { 'x-kody-secret-resolution': 'off' }
export default (init: RequestInit) =>
	fetch('https://x.test', { ...init, headers: quoting, body: 'Docs: {{secret:a}}' })
`,
		}),
	).toEqual([])
})
