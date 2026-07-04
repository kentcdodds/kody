export const FRAME_SPIKE_TARGET = 'spike-data'
export const REMIX_FRAME_TARGET_HEADER = 'x-remix-target'

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
