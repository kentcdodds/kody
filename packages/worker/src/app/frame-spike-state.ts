export const FRAME_SPIKE_TARGET = 'spike-data'

let counter = 0

export function getFrameSpikeCounter() {
	return counter
}

export function incrementFrameSpikeCounter() {
	counter += 1
	return counter
}

export function resetFrameSpikeCounterForTests() {
	counter = 0
}
