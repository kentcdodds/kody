import { expect, test } from 'vitest'
import {
	inferCodemodeCapabilities,
	inferCodemodeCapabilitiesFromAst,
} from './infer-codemode-capabilities.ts'
import { parse, type Program } from 'acorn'

test('infers static codemode member names', () => {
	const src = `async () => {
    return await codemode.ui_save_app({
      title: 'Demo',
      description: 'Demo app',
      code: '<main>demo</main>',
    })
  }`
	const { staticNames, inferencePartial } = inferCodemodeCapabilities(src)
	expect(inferencePartial).toBe(false)
	expect(staticNames).toEqual(['ui_save_app'])
})

test('infers bracket string literal access', () => {
	const src = `async () => await codemode['github_rest']({ method: 'GET', path: '/rate_limit' })`
	const { staticNames } = inferCodemodeCapabilities(src)
	expect(staticNames).toContain('github_rest')
})

test('infers secret_set member access', () => {
	const src = `async () => {
    const refreshedToken = 'token-from-refresh';
    await codemode.secret_set({
      name: 'spotifyAccessToken',
      value: refreshedToken,
      scope: 'user',
      description: 'Spotify OAuth access token',
    });
  }`
	const { staticNames, inferencePartial } = inferCodemodeCapabilities(src)
	expect(inferencePartial).toBe(false)
	expect(staticNames).toContain('secret_set')
})

test('marks partial for computed non-literal codemode access', () => {
	const program = parse(
		`async () => { const x = 'ui_save_app'; return await codemode[x]({}) }`,
		{ ecmaVersion: 'latest', sourceType: 'module' },
	) as Program
	const { inferencePartial } = inferCodemodeCapabilitiesFromAst(program)
	expect(inferencePartial).toBe(true)
})

test('infers capabilities from known execute-time helper module imports', () => {
	const src = `async () => {
    const { createCodemodeUtils } = await import('@kody/codemode-utils')
    const { refreshAccessToken } = createCodemodeUtils(codemode)
    return await refreshAccessToken('spotify')
  }`
	const { moduleNames, inferencePartial } = inferCodemodeCapabilities(src)
	expect(inferencePartial).toBe(false)
	expect(moduleNames).toEqual(['connector_get', 'value_get'])
})
