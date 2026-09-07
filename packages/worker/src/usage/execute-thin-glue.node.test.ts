import { expect, test } from 'vitest'
import { classifyExecuteThinGlue } from './execute-thin-glue.ts'

test('classifies a single kody:@ passthrough default export', () => {
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
export default list`),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(`import { listRepos } from 'kody:@acme/github/listRepos'
export default listRepos`),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
export default async function main(input) {
	return await list(input)
}`),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
export default async function main(...args) {
	return await list(...args)
}`),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
export default (input) => list(input)`),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(
			`export { default } from 'kody:@acme/github/listRepos'`,
		),
	).toBe('thin_single_export')
	expect(
		classifyExecuteThinGlue(
			`export { listRepos as default } from 'kody:@acme/github/listRepos'`,
		),
	).toBe('thin_single_export')
})

test('classifies a few kody:@ imports that are not a single passthrough', () => {
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
export default async function main(input) {
	const repos = await list(input)
	return repos.slice(0, 5)
}`),
	).toBe('thin_few_exports')
	expect(
		classifyExecuteThinGlue(`import list from 'kody:@acme/github/listRepos'
import get from 'kody:@acme/github/getRepo'
export default async function main(input) {
	const repos = await list(input)
	return await get({ name: repos[0].name })
}`),
	).toBe('thin_few_exports')
	expect(
		classifyExecuteThinGlue(`import a from 'kody:@acme/one'
import b from 'kody:@acme/two'
import c from 'kody:@acme/three'
export default async function main() {
	return { a: await a(), b: await b(), c: await c() }
}`),
	).toBe('thin_few_exports')
})

test('classifies parseable non-thin modules as glue', () => {
	expect(
		classifyExecuteThinGlue(`import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.emailList({})
}`),
	).toBe('glue')
	expect(
		classifyExecuteThinGlue(`import a from 'kody:@acme/one'
import b from 'kody:@acme/two'
import c from 'kody:@acme/three'
import d from 'kody:@acme/four'
export default async function main() {
	return [await a(), await b(), await c(), await d()]
}`),
	).toBe('glue')
	expect(
		classifyExecuteThinGlue(`export default async function main() {
	return { ok: true }
}`),
	).toBe('glue')
})

test('omits a class when the source cannot be parsed', () => {
	expect(classifyExecuteThinGlue('export default function (')).toBeNull()
	expect(classifyExecuteThinGlue('const =')).toBeNull()
})
