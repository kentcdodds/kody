import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	recordSearchObservabilityEvent,
	searchObservabilityTelemetryIndex,
} from './search-observability.ts'

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
		blobs: ['success', 'list', 'inspect', 'trimmed', 'online'],
		doubles: [12389, 7436, 2114, 4000, 2114, 1967, 725, 0.18, 13],
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
