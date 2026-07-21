import { expect, test } from 'vitest'
import {
	createUnboundRuntimeHelperMessage,
	findUnboundRuntimeHelperAccess,
	parseUnboundRuntimeHelperMessage,
} from './unbound-runtime-helpers.ts'

const allOptionalHelperNames = new Set([
	'storage',
	'refreshAccessToken',
	'createAuthenticatedFetch',
	'secretHeaders',
	'oauthClientCredentials',
	'service',
	'packageSecrets',
	'email',
	'workflows',
	'packages',
	'events',
])

test('findUnboundRuntimeHelperAccess matches guard-less reads, calls, aliases, namespaces, and inlined helpers', () => {
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'entry.js': `import { storage } from 'kody:runtime'

export default async function main() {
	const result = await storage.sql('select 1')
	return result.rows
}`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'storage',
		reference: 'storage.sql',
	})

	// Helpers with a `null` absent value fail the same way.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage:
				"TypeError: Cannot read properties of null (reading 'getMessage')",
			modules: {
				'entry.js': `import { email } from 'kody:runtime'
export default async () => await email.getMessage('m-1')`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'email',
		reference: 'email.getMessage',
	})

	// Bundled saved-package modules import the virtual runtime module through
	// a rewritten relative path and may alias the binding.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'entry.js': {
					js: `import { storage as db } from '../.__kody_virtual__/runtime.js'
export default async () => (await db.sql('select 1')).rows`,
				},
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'storage',
		reference: 'storage.sql',
	})

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'entry.js': `import * as runtime from 'kody:runtime'
export default async () => await runtime.storage.sql('select 1')`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'storage',
		reference: 'storage.sql',
	})

	// Real bundles inline the virtual runtime module into the entry module,
	// so helpers are top-level declarations rather than import bindings.
	const inlinedSource = `var storage = __kodyOptionalRuntimeObjectExport("storage", void 0);
var refreshAccessToken = __kodyOptionalRuntimeFunctionExport("refreshAccessToken");
async function main() {
	const result = await storage.sql("select 1");
	return result.rows;
}`

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: { 'bundle.js': inlinedSource },
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'storage',
		reference: 'storage.sql',
	})

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: 'refreshAccessToken is not a function',
			modules: { 'bundle.js': inlinedSource },
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'refreshAccessToken',
		reference: 'refreshAccessToken',
	})

	// A declaration initialized by an unrelated factory is not a helper.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'bundle.js': `var storage = createMyStorage("storage");
async function main() { return (await storage.sql("select 1")).rows }`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toBeNull()

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: 'TypeError: refreshAccessToken is not a function',
			modules: {
				'entry.js': `import { refreshAccessToken } from 'kody:runtime'
export default async () => await refreshAccessToken('google-personal')`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'refreshAccessToken',
		reference: 'refreshAccessToken',
	})

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: 'runtime.oauthClientCredentials is not a function',
			modules: {
				'entry.js': `import * as runtime from 'kody:runtime'
export default async () => await runtime.oauthClientCredentials({})`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toEqual({
		helperName: 'oauthClientCredentials',
		reference: 'oauthClientCredentials',
	})
})

test('findUnboundRuntimeHelperAccess leaves unrelated errors and bound helpers unhinted', () => {
	const modules = {
		'entry.js': `import { storage } from 'kody:runtime'
export default async () => (await storage.sql('select 1')).rows`,
	}

	// The helper is bound in this run, so the TypeError is a user-code bug.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules,
			unboundHelperNames: new Set(['email']),
		}),
	).toBeNull()

	// The failed property read does not appear on any runtime helper binding.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'rows')",
			modules,
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toBeNull()

	// Optional chaining short-circuits instead of throwing, so guarded access
	// must not be treated as the source of the TypeError.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'entry.js': `import { storage } from 'kody:runtime'
export default async () => (await storage?.sql('select 1')) ?? null`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toBeNull()

	// A same-named binding from another module is not a runtime helper.
	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of undefined (reading 'sql')",
			modules: {
				'entry.js': `import { storage } from './my-storage.js'
export default async () => (await storage.sql('select 1')).rows`,
			},
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toBeNull()

	expect(
		findUnboundRuntimeHelperAccess({
			errorMessage: 'Execution timed out',
			modules,
			unboundHelperNames: allOptionalHelperNames,
		}),
	).toBeNull()
})

test('createUnboundRuntimeHelperMessage round-trips through parseUnboundRuntimeHelperMessage', () => {
	const message = createUnboundRuntimeHelperMessage({
		originalMessage: "Cannot read properties of undefined (reading 'sql')",
		helperName: 'storage',
		reference: 'storage.sql',
	})
	expect(message).toContain(
		"Cannot read properties of undefined (reading 'sql')",
	)
	expect(parseUnboundRuntimeHelperMessage(message)).toBe('storage')

	// Wrapped transports (for example package invocation responses) prefix
	// the message; parsing must stay prefix-tolerant.
	expect(
		parseUnboundRuntimeHelperMessage(`[execution_failed] ${message}`),
	).toBe('storage')

	expect(
		parseUnboundRuntimeHelperMessage(
			"Cannot read properties of undefined (reading 'sql')",
		),
	).toBeNull()
})
