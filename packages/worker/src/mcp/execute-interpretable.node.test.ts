import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	classifyExecuteInterpretable,
	executeInterpretableTelemetryIndex,
	recordExecuteInterpretableEvent,
} from './execute-interpretable.ts'

test('classifies glue-only execute modules and each documented disqualifier', () => {
	expect(
		classifyExecuteInterpretable(`import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.capability_id({})
}`),
	).toEqual({ class: 'interpretable', reason: 'glue' })

	expect(
		classifyExecuteInterpretable(`import { email, workflows } from 'kody:runtime'
export default async function main() {
	return await email.send({ to: 'a@example.com', subject: 'hi', text: 'hi' })
}`),
	).toEqual({ class: 'interpretable', reason: 'glue' })

	expect(
		classifyExecuteInterpretable(
			'export default async function main() { return { ok: true } }',
		),
	).toEqual({ class: 'interpretable', reason: 'glue' })

	expect(
		classifyExecuteInterpretable(
			`import type { Config } from 'kody:@owner/types/config'
import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.capability_id({})
}`,
		),
	).toEqual({ class: 'interpretable', reason: 'glue' })

	expect(
		classifyExecuteInterpretable(
			`import whatShipped from 'kody:@you/kody-bot-shipped/whatShipped'
export default async function main() {
	return await whatShipped({})
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_package_import' })

	expect(
		classifyExecuteInterpretable(
			`const mod = await import('kody:@scope/notes/note-list')
export default async function main() {
	return await mod.default({})
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_package_import' })

	expect(
		classifyExecuteInterpretable(
			`import { get } from 'lodash'
export default async function main() {
	return get({ a: 1 }, 'a')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_npm' })

	expect(
		classifyExecuteInterpretable(
			`import { createHash } from 'node:crypto'
export default async function main() {
	return createHash('sha256').update('x').digest('hex')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_node_builtin' })

	expect(
		classifyExecuteInterpretable(
			`export default async function main() {
	return await fetch('https://example.com')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_fetch' })

	expect(
		classifyExecuteInterpretable(
			`export default async function main() {
	return await globalThis.fetch('https://example.com')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_fetch' })

	expect(
		classifyExecuteInterpretable(
			`import { createAuthenticatedFetch } from 'kody:runtime'
export default async function main() {
	const authFetch = createAuthenticatedFetch('github')
	return await authFetch('https://api.github.com/user')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_fetch' })

	expect(
		classifyExecuteInterpretable(
			`const specifier = condition ? 'kody:runtime' : 'lodash'
const mod = await import(specifier)
export default async function main() {
	return mod
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_dynamic_import' })

	expect(
		classifyExecuteInterpretable(
			`import { connect } from 'cloudflare:sockets'
export default async function main() {
	return connect
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_unsupported_import' })

	expect(
		classifyExecuteInterpretable(
			`import helper from './helper.ts'
export default async function main() {
	return helper()
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_unsupported_import' })

	expect(
		classifyExecuteInterpretable('export default async function main( {'),
	).toEqual({
		class: 'non_interpretable',
		reason: 'unparseable',
	})

	expect(
		classifyExecuteInterpretable(
			`import whatShipped from 'kody:@you/bot/whatShipped'
import { get } from 'lodash'
export default async function main() {
	return await fetch('https://example.com')
}`,
		),
	).toEqual({ class: 'non_interpretable', reason: 'has_package_import' })
})

test('records a privacy-safe payload and never throws when unavailable or broken', () => {
	const writeDataPoint = vi.fn()
	recordExecuteInterpretableEvent(
		{
			EXECUTE_INTERPRETABLE_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			source: `import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.secretGet({ name: 'token' })
}`,
		},
	)
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: [executeInterpretableTelemetryIndex],
		blobs: ['interpretable', 'glue'],
		doubles: [1],
	})

	recordExecuteInterpretableEvent(
		{
			EXECUTE_INTERPRETABLE_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			source: `import secretHelper from 'kody:@private-owner/secret-package/private-export'
export default async function main() {
	return await secretHelper({ token: 'super-secret-value' })
}`,
		},
	)
	expect(writeDataPoint).toHaveBeenLastCalledWith({
		indexes: [executeInterpretableTelemetryIndex],
		blobs: ['non_interpretable', 'has_package_import'],
		doubles: [1],
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('private')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain(
		'super-secret',
	)

	expect(() =>
		recordExecuteInterpretableEvent(
			{},
			{
				source:
					"import { kody } from 'kody:runtime'\nexport default async function main() {}",
			},
		),
	).not.toThrow()

	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordExecuteInterpretableEvent(
			{
				EXECUTE_INTERPRETABLE_EVENTS: {
					writeDataPoint() {
						throw new Error('unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{ source: 'export default async function main() { return 1 }' },
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
		'execute-interpretable-event-failed',
		expect.any(Error),
	)
})
