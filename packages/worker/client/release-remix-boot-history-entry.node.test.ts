import { expect, test } from 'vitest'
import {
	type BootHistoryNavigationLike,
	releaseRemixBootHistoryEntry,
} from './release-remix-boot-history-entry.ts'

function createNavigation(state: unknown) {
	let current = state
	const updates: Array<unknown> = []
	const navigation: BootHistoryNavigationLike = {
		currentEntry: { getState: () => current },
		updateCurrentEntry({ state: next }) {
			updates.push(next)
			current = next
		},
	}
	return { navigation, updates, read: () => current }
}

test('clears the Remix top-frame state Remix put on the boot entry', () => {
	const { navigation, read } = createNavigation({
		target: undefined,
		src: 'https://kody.codes/',
		resetScroll: true,
		$rmx: true,
	})

	releaseRemixBootHistoryEntry(navigation)

	expect(read()).toBeNull()
})

test('keeps named-frame entries and non-Remix state for their owners', () => {
	const frameEntry = createNavigation({
		target: 'community-listings',
		src: '/community?q=notes',
		resetScroll: true,
		$rmx: true,
	})
	releaseRemixBootHistoryEntry(frameEntry.navigation)
	expect(frameEntry.updates).toEqual([])

	for (const state of [undefined, null, { key: 'scroll-key' }, 'text']) {
		const other = createNavigation(state)
		releaseRemixBootHistoryEntry(other.navigation)
		expect(other.updates).toEqual([])
	}
})

test('is a no-op without the Navigation API or when the update throws', () => {
	expect(() => releaseRemixBootHistoryEntry(undefined)).not.toThrow()
	expect(() =>
		releaseRemixBootHistoryEntry({
			currentEntry: null,
			updateCurrentEntry: () => {
				throw new Error('unexpected update')
			},
		}),
	).not.toThrow()
	expect(() =>
		releaseRemixBootHistoryEntry({
			currentEntry: { getState: () => ({ $rmx: true }) },
			updateCurrentEntry: () => {
				throw new DOMException('inactive', 'InvalidStateError')
			},
		}),
	).not.toThrow()
})
