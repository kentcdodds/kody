import { expect, test } from 'vitest'

import {
	pickJevSearchEvalTelemetry,
	shouldExposeJevSearchEvalTelemetry,
} from './search-jev-eval-telemetry.ts'

test('shouldExposeJevSearchEvalTelemetry is admin or flag-on only', () => {
	expect(
		shouldExposeJevSearchEvalTelemetry({
			isAdmin: false,
			jevRerankEnabled: false,
		}),
	).toBe(false)
	expect(
		shouldExposeJevSearchEvalTelemetry({
			isAdmin: true,
			jevRerankEnabled: false,
		}),
	).toBe(true)
	expect(
		shouldExposeJevSearchEvalTelemetry({
			isAdmin: false,
			jevRerankEnabled: true,
		}),
	).toBe(true)
})

test('pickJevSearchEvalTelemetry keeps a small eval slice', () => {
	expect(pickJevSearchEvalTelemetry({})).toBeNull()
	expect(
		pickJevSearchEvalTelemetry({
			jevRerank: {
				enabled: true,
				outcome: 'applied',
				candidatesBefore: 40,
				candidatesAfter: 8,
				droppedCount: 12,
				meanConfidence: 0.81,
				top1Type: 'capability',
			},
			jevRerankMs: 42.5,
		}),
	).toEqual({
		enabled: true,
		outcome: 'applied',
		candidatesBefore: 40,
		candidatesAfter: 8,
		droppedCount: 12,
		meanConfidence: 0.81,
		top1Type: 'capability',
		jevRerankMs: 42.5,
	})
})
