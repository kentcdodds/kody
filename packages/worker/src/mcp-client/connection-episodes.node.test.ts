import { expect, test } from 'vitest'
import {
	createInitialMcpConnectionEpisode,
	mcpServerDisconnectedTopic,
	mcpServerReconnectedTopic,
	observeMcpConnectionState,
} from './connection-episodes.ts'

function observe(input: {
	previous?: ReturnType<typeof createInitialMcpConnectionEpisode>
	currentState: Parameters<typeof observeMcpConnectionState>[0]['currentState']
	retryCompleted?: boolean
	episodeId?: string
}) {
	return observeMcpConnectionState({
		previous: input.previous ?? createInitialMcpConnectionEpisode(),
		currentState: input.currentState,
		retryCompleted: input.retryCompleted ?? false,
		createEpisodeId: () => input.episodeId ?? 'episode-1',
	})
}

test('MCP connection episodes retry then emit once per down period', () => {
	const firstReady = observe({ currentState: 'ready' })
	expect(firstReady).toEqual({
		next: {
			lastObservedState: 'ready',
			wasReady: true,
			episodeId: null,
			disconnectedEmitted: false,
		},
		shouldRetry: false,
		event: null,
	})

	const neverReady = observe({ currentState: 'disconnected' })
	expect(neverReady.shouldRetry).toBe(false)
	expect(neverReady.event).toBeNull()

	const downFromReady = observe({
		previous: firstReady.next,
		currentState: 'disconnected',
	})
	expect(downFromReady.shouldRetry).toBe(true)
	expect(downFromReady.event).toBeNull()

	const recoveredDuringRetry = observe({
		previous: downFromReady.next,
		currentState: 'ready',
		retryCompleted: true,
	})
	expect(recoveredDuringRetry.event).toBeNull()
	expect(recoveredDuringRetry.next.wasReady).toBe(true)
	expect(recoveredDuringRetry.next.episodeId).toBeNull()

	const stillDownAfterRetry = observe({
		previous: downFromReady.next,
		currentState: 'failed',
		retryCompleted: true,
		episodeId: 'episode-home',
	})
	expect(stillDownAfterRetry.shouldRetry).toBe(false)
	expect(stillDownAfterRetry.event).toEqual({
		topic: mcpServerDisconnectedTopic,
		episodeId: 'episode-home',
		previousState: 'ready',
	})
	expect(stillDownAfterRetry.next.disconnectedEmitted).toBe(true)

	const repeatWhileDown = observe({
		previous: stillDownAfterRetry.next,
		currentState: 'disconnected',
	})
	expect(repeatWhileDown.shouldRetry).toBe(false)
	expect(repeatWhileDown.event).toBeNull()

	const authenticatingAfterReady = observe({
		previous: firstReady.next,
		currentState: 'authenticating',
	})
	expect(authenticatingAfterReady.shouldRetry).toBe(false)
	expect(authenticatingAfterReady.event?.topic).toBe(mcpServerDisconnectedTopic)

	const inFlight = observe({
		previous: firstReady.next,
		currentState: 'connecting',
	})
	expect(inFlight.event).toBeNull()
	expect(inFlight.shouldRetry).toBe(false)
	expect(inFlight.next.wasReady).toBe(true)

	const reconnected = observe({
		previous: stillDownAfterRetry.next,
		currentState: 'ready',
	})
	expect(reconnected.event).toEqual({
		topic: mcpServerReconnectedTopic,
		episodeId: 'episode-home',
		previousState: 'failed',
	})
	expect(reconnected.next.episodeId).toBeNull()
	expect(reconnected.next.disconnectedEmitted).toBe(false)
})
