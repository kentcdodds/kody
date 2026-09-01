import { expect, test } from 'vitest'
import { runSurfaceValues } from '#worker/run-records/types.ts'
import { shouldRecordExecuteUsageForRun } from './execute-usage-surface.ts'

test('only MCP execute-tool runs record the execute usage metric', () => {
	expect(
		shouldRecordExecuteUsageForRun({
			surface: 'execute',
			hasPackageContext: false,
		}),
	).toBe(true)
	expect(
		shouldRecordExecuteUsageForRun({
			surface: 'execute',
			hasPackageContext: true,
		}),
	).toBe(true)

	const nestedSurfaces = runSurfaceValues.filter(
		(surface) => surface !== 'execute',
	)
	for (const surface of nestedSurfaces) {
		expect(
			shouldRecordExecuteUsageForRun({
				surface,
				hasPackageContext: false,
			}),
		).toBe(false)
		expect(
			shouldRecordExecuteUsageForRun({
				surface,
				hasPackageContext: true,
			}),
		).toBe(false)
	}

	expect(
		shouldRecordExecuteUsageForRun({
			surface: null,
			hasPackageContext: false,
		}),
	).toBe(true)
	expect(
		shouldRecordExecuteUsageForRun({
			surface: undefined,
			hasPackageContext: true,
		}),
	).toBe(false)
})
