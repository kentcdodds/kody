import { expect, test } from 'vitest'
import {
	injectLocalExecuteGatewayFetchBinding,
	moduleSourceHasSecretPlaceholderLiterals,
	rewriteLocalExecuteModuleForSecretAwareFetch,
	rewriteLocalExecuteSecretPlaceholderLiterals,
} from './rewrite-local-execute-secret-fetch.ts'

test('rewriteLocalExecuteSecretPlaceholderLiterals removes resolvable template literals', () => {
	const source = `const token = '{{secret:demoToken|scope=user}}'
export async function request() {
  return fetch('https://api.example.com/v1', {
    headers: { authorization: 'Bearer ' + token },
  })
}`
	expect(moduleSourceHasSecretPlaceholderLiterals(source)).toBe(true)
	const rewritten = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(moduleSourceHasSecretPlaceholderLiterals(rewritten.source)).toBe(false)
})

test('rewriteLocalExecuteSecretPlaceholderLiterals leaves non-computed object keys alone', () => {
	const source = `const map = { '{{secret:demoToken|scope=user}}': true }
const value = '{{secret:demoToken|scope=user}}'
`
	const rewritten = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).toContain(
		"{ '{{secret:demoToken|scope=user}}': true }",
	)
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
})

test('rewriteLocalExecuteModuleForSecretAwareFetch binds gateway fetch and strips templates', () => {
	const source = `const SECRET = '{{secret:demoToken|scope=user}}'
export async function listSites() {
  return fetch('https://api.usefathom.com/v1/sites', {
    headers: { authorization: 'Bearer ' + SECRET },
  })
}`
	const rewritten = rewriteLocalExecuteModuleForSecretAwareFetch({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
		packageId: 'pkg-demo',
	})
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(rewritten.source).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(rewritten.source).toContain('"pkg-demo"')
	expect(rewritten.source).toMatch(
		/const fetch = __kodyCreatePackageBoundGatewayFetch/,
	)
})

test('injectLocalExecuteGatewayFetchBinding skips when fetch is already bound', () => {
	const source = `const fetch = globalThis.fetch;
const SECRET = '{{secret:demoToken|scope=user}}';
`
	const placeholders = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	const injected = injectLocalExecuteGatewayFetchBinding({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source: placeholders.source,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
		packageId: 'pkg-demo',
	})
	expect(injected.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(injected.source).toContain('import { __kodySecretRef }')
	expect(injected.source).not.toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(injected.source).toMatch(/const fetch = globalThis\.fetch/)
})

test('injectLocalExecuteGatewayFetchBinding is idempotent when gateway fetch is already bound', () => {
	const source = `import { __kodyCreatePackageBoundGatewayFetch, __kodySecretRef } from "../../.__kody_virtual__/runtime.js";
const fetch = __kodyCreatePackageBoundGatewayFetch("pkg-demo");
const SECRET = __kodySecretRef("demoToken", "user");
`
	const again = injectLocalExecuteGatewayFetchBinding({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
		packageId: 'pkg-demo',
	})
	expect(again.rewritten).toBe(false)
	expect(again.source).toBe(source)
})
