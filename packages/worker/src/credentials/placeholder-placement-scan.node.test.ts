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
		{ path: 'src/index.ts', line: 11, slot: 'github', location: 'url or body' },
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
