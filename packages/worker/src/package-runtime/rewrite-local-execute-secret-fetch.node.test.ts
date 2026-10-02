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

test('injectLocalExecuteGatewayFetchBinding is idempotent when fetch is already bound', () => {
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
