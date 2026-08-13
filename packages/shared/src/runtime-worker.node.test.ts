import { expect, test } from 'vitest'
import { buildRuntimeWorkerHealth } from './runtime-worker.ts'

test('runtime health reports whether COOKIE_SECRET is configured', () => {
	expect(
		buildRuntimeWorkerHealth({
			commitSha: '  abc  ',
			cookieSecretConfigured: true,
		}),
	).toEqual({
		status: 'ok',
		commitSha: 'abc',
		cookieSecretConfigured: true,
	})
	expect(
		buildRuntimeWorkerHealth({
			commitSha: undefined,
			cookieSecretConfigured: false,
		}),
	).toEqual({
		status: 'ok',
		commitSha: null,
		cookieSecretConfigured: false,
	})
})
