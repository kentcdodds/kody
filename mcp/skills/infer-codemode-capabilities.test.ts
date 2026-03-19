import { expect, test } from 'bun:test'
import {
	inferCodemodeCapabilities,
	inferCodemodeCapabilitiesFromAst,
} from './infer-codemode-capabilities.ts'
import { parse, type Program } from 'acorn'

test('infers static codemode member names', () => {
	const src = `async () => {
    return await codemode.do_math({ left: 1, operator: '+', right: 2 })
  }`
	const { staticNames, inferencePartial } = inferCodemodeCapabilities(src)
	expect(inferencePartial).toBe(false)
	expect(staticNames).toEqual(['do_math'])
})

test('infers bracket string literal access', () => {
	const src = `async () => await codemode['github_rest']({ method: 'GET', path: '/rate_limit' })`
	const { staticNames } = inferCodemodeCapabilities(src)
	expect(staticNames).toContain('github_rest')
})

test('marks partial for computed non-literal codemode access', () => {
	const program = parse(
		`async () => { const x = 'do_math'; return await codemode[x]({}) }`,
		{ ecmaVersion: 'latest', sourceType: 'module' },
	) as Program
	const { inferencePartial } = inferCodemodeCapabilitiesFromAst(program)
	expect(inferencePartial).toBe(true)
})
