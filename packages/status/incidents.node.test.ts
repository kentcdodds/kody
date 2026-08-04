import { expect, test } from 'vitest'
import {
	applyProbeResult,
	failureThreshold,
	initialComponentProbeState,
	recoveryThreshold,
	type ComponentProbeState,
} from './incidents.ts'

function run(
	state: ComponentProbeState,
	results: Array<boolean>,
): { state: ComponentProbeState; transitions: Array<string | null> } {
	const transitions: Array<string | null> = []
	let current = state
	for (const ok of results) {
		const applied = applyProbeResult(current, ok)
		current = applied.state
		transitions.push(applied.transition)
	}
	return { state: current, transitions }
}

test('a single failure does not open an incident', () => {
	const { state, transitions } = run(initialComponentProbeState, [false, true])
	expect(transitions).toEqual([null, null])
	expect(state.status).toBe('operational')
})

test('consecutive failures at the threshold open exactly one incident', () => {
	const failures = Array.from({ length: failureThreshold + 2 }, () => false)
	const { state, transitions } = run(initialComponentProbeState, failures)
	expect(
		transitions.filter((transition) => transition === 'opened'),
	).toHaveLength(1)
	expect(transitions[failureThreshold - 1]).toBe('opened')
	expect(state.status).toBe('down')
})

test('a single success while down does not resolve the incident', () => {
	const { state: downState } = run(initialComponentProbeState, [false, false])
	expect(downState.status).toBe('down')
	const { state, transitions } = run(downState, [true])
	if (recoveryThreshold > 1) {
		expect(transitions).toEqual([null])
		expect(state.status).toBe('down')
	}
})

test('consecutive successes at the threshold resolve the incident once', () => {
	const { state: downState } = run(initialComponentProbeState, [false, false])
	const successes = Array.from({ length: recoveryThreshold + 2 }, () => true)
	const { state, transitions } = run(downState, successes)
	expect(
		transitions.filter((transition) => transition === 'resolved'),
	).toHaveLength(1)
	expect(state.status).toBe('operational')
})

test('flapping between success and failure never crosses either threshold', () => {
	const { state, transitions } = run(initialComponentProbeState, [
		false,
		true,
		false,
		true,
		false,
		true,
	])
	expect(transitions.every((transition) => transition === null)).toBe(true)
	expect(state.status).toBe('operational')
})
