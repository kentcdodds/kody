import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	encodeSearchTop1Type,
	recordSearchObservabilityEvent,
	searchObservabilityTelemetryIndex,
} from './search-observability.ts'

test('encodeSearchTop1Type maps known types and unknowns to -1', () => {
	expect(encodeSearchTop1Type('capability')).toBe(1)
	expect(encodeSearchTop1Type('guide')).toBe(2)
	expect(encodeSearchTop1Type('package')).toBe(3)
	expect(encodeSearchTop1Type('mcp-server')).toBe(4)
	expect(encodeSearchTop1Type('unknown')).toBe(-1)
	expect(encodeSearchTop1Type(null)).toBe(-1)
})

test('recordSearchObservabilityEvent writes duration and exclusive tiles, no-ops without binding, and swallows sink errors', () => {
	const writeDataPoint = vi.fn()
	recordSearchObservabilityEvent(
		{
			MCP_SEARCH_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			outcome: 'success',
			mode: 'list',
			durationMs: 12389,
			task: 'inspect',
			intentConfidence: 0.18,
			responseTrimmed: true,
			trimmedMatchCount: 13,
			offline: false,
			jevFlagCohort: 'on',
			jevOutcome: 'applied',
			candidatesBeforeJev: 40,
			candidatesAfterJev: 12,
			jevDroppedCount: 28,
			jevMeanConfidence: 0.82,
			jevDurationMs: 310,
			top1TypeCode: encodeSearchTop1Type('capability'),
			phaseTimings: {
				unaccountedMs: 7436,
				loadAndRankMs: 2114,
				waitingItemsMs: 4000,
				memoryEnrichmentMs: 2114,
				rowAndRegistryLoadMs: 1967,
				retrieversMs: 725,
			},
		},
	)
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: [searchObservabilityTelemetryIndex],
		blobs: ['success', 'list', 'inspect', 'trimmed', 'online', 'on', 'applied'],
		doubles: [
			12389, 7436, 2114, 4000, 2114, 1967, 725, 0.18, 13, 40, 12, 28, 0.82, 310,
			1,
		],
	})

	expect(() =>
		recordSearchObservabilityEvent(
			{},
			{
				outcome: 'failure',
				mode: 'entity',
				durationMs: 12,
			},
		),
	).not.toThrow()

	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordSearchObservabilityEvent(
			{
				MCP_SEARCH_EVENTS: {
					writeDataPoint() {
						throw new Error('ae unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{
				outcome: 'success',
				mode: 'list',
				durationMs: 1,
			},
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
		'mcp-search-event-failed',
		expect.any(Error),
	)
})
