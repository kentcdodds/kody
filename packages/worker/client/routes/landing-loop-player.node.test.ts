import { expect, test, vi } from 'vitest'
import { howKodyWorksTranscriptActs } from './how-kody-works-transcript.ts'
import {
	createLandingLoopPlayer,
	flattenTranscriptActs,
	groupLandingLoopScenes,
	landingLoopChatScrollShouldExplore,
	landingLoopHoldMs,
	landingLoopTeaserBeatCount,
	landingLoopToggleLabel,
	waitLandingLoopHold,
} from './landing-loop-state.ts'

test('homepage loop player pauses for hover and explore, then play resumes and restarts at the end', async () => {
	const beats = flattenTranscriptActs(howKodyWorksTranscriptActs)
	expect(beats[0]).toMatchObject({
		kind: 'act',
		id: 'ask',
		scene: 'desk',
	})
	expect(beats[1]).toMatchObject({
		kind: 'line',
		actId: 'ask',
		scene: 'desk',
		line: { role: 'user' },
	})
	for (const beat of [
		{
			kind: 'act',
			id: 'invoke',
			scene: 'phone',
			kicker: expect.stringContaining('{invoke}'),
		},
		{
			kind: 'act',
			id: 'notify',
			scene: 'phone',
			kicker: expect.stringContaining('{notify}'),
		},
		{ kind: 'act', id: 'mail', later: 'The next day' },
		{
			kind: 'line',
			actId: 'mail',
			line: expect.objectContaining({ role: 'email' }),
		},
		{ kind: 'line', line: expect.objectContaining({ role: 'tools' }) },
	]) {
		expect(beats).toContainEqual(expect.objectContaining(beat))
	}
	expect(
		groupLandingLoopScenes(beats).map((group) => ({
			scene: group.scene,
			act:
				group.beats[0]?.kind === 'act'
					? group.beats[0].id
					: group.beats[0]?.actId,
		})),
	).toEqual([
		{ scene: 'desk', act: 'ask' },
		{ scene: 'phone', act: 'invoke' },
		{ scene: 'phone', act: 'notify' },
		{ scene: 'desk', act: 'mail' },
	])

	// Only a user-driven scroll away from the bottom (not auto-scroll) explores.
	const scrolls: Array<[boolean, boolean, boolean, boolean]> = [
		[true, true, false, false],
		[false, false, false, false],
		[false, true, true, false],
		[false, true, false, true],
	]
	expect(
		scrolls.filter(
			([autoScrolling, userDriven, atBottom, want]) =>
				landingLoopChatScrollShouldExplore({
					autoScrolling,
					userDriven,
					atBottom,
				}) !== want,
		),
	).toEqual([])

	const player = createLandingLoopPlayer({
		beatCount: beats.length,
		reducedMotion: false,
	})
	expect(player.revealedCount).toBe(landingLoopTeaserBeatCount)
	expect(player.isPaused()).toBe(false)
	expect(landingLoopHoldMs(beats[0]!)).toBe(1100)

	player.setHover(true)
	expect(player.isPaused()).toBe(true)
	expect(player.advance()).toEqual({ didAdvance: false, ended: false })

	player.setExplore(true)
	player.setHover(false)
	expect(player.isPaused()).toBe(true)
	expect(player.pauseReasons()).toEqual(['explore'])

	player.play()
	expect(player.isPaused()).toBe(false)
	expect(player.advance()).toEqual({ didAdvance: true, ended: false })
	expect(player.revealedCount).toBe(landingLoopTeaserBeatCount + 1)

	player.setHover(true)
	player.play()
	expect(player.isPaused()).toBe(false)
	player.setHover(true)
	expect(player.isPaused()).toBe(false)
	player.setHover(false)
	player.setHover(true)
	expect(player.isPaused()).toBe(true)

	player.setFocus(true)
	player.setHover(false)
	expect(player.isPaused()).toBe(true)
	player.play()
	expect(player.isPaused()).toBe(false)
	player.setFocus(false)
	player.setFocus(true)
	expect(player.isPaused()).toBe(true)
	player.play()

	player.pause()
	expect(player.isPaused()).toBe(true)
	player.play()
	player.setFocus(true)
	expect(player.isPaused()).toBe(false)
	player.setExplore(true)
	expect(player.pauseReasons()).toEqual(['explore'])
	player.play()
	expect(player.isPaused()).toBe(false)

	const still = createLandingLoopPlayer({
		beatCount: beats.length,
		reducedMotion: true,
	})
	expect(still.revealedCount).toBe(beats.length)
	expect(still.isPaused()).toBe(true)
	expect(still.advance()).toEqual({ didAdvance: false, ended: false })

	const state = (p: typeof player) => ({
		revealed: p.revealedCount,
		ended: p.isEnded(),
		paused: p.isPaused(),
	})
	const teaser = landingLoopTeaserBeatCount
	const finisher = createLandingLoopPlayer({
		beatCount: 3,
		reducedMotion: false,
	})
	expect(finisher.revealedCount).toBe(teaser)
	expect(finisher.advance()).toEqual({ didAdvance: true, ended: false })
	expect(finisher.revealedCount).toBe(3)
	expect(finisher.advance()).toEqual({ didAdvance: false, ended: true })
	expect(state(finisher)).toEqual({ revealed: 3, ended: true, paused: true })
	finisher.play()
	expect(state(finisher)).toEqual({ revealed: 3, ended: true, paused: true })
	finisher.restart()
	expect(state(finisher)).toEqual({
		revealed: teaser,
		ended: false,
		paused: false,
	})
	expect(finisher.advance()).toEqual({ didAdvance: true, ended: false })

	const skipper = createLandingLoopPlayer({
		beatCount: 5,
		reducedMotion: false,
	})
	skipper.setHover(true)
	skipper.skipToEnd()
	expect(state(skipper)).toEqual({ revealed: 5, ended: true, paused: true })
	expect(skipper.pauseReasons()).toEqual(['ended'])
	skipper.skipToEnd()
	expect(state(skipper)).toMatchObject({ revealed: 5, ended: true })
	skipper.restart()
	expect(state(skipper)).toMatchObject({ revealed: teaser, ended: false })

	vi.useFakeTimers()
	try {
		const controller = new AbortController()
		let paused = true
		const listeners = new Set<() => void>()
		const hold = waitLandingLoopHold({
			ms: 400,
			isPaused: () => paused,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			},
			signal: controller.signal,
		})
		await vi.advanceTimersByTimeAsync(400)
		paused = false
		for (const listener of listeners) listener()
		await vi.advanceTimersByTimeAsync(400)
		await expect(hold).resolves.toBe(true)

		const aborted = waitLandingLoopHold({
			ms: 800,
			isPaused: () => false,
			subscribe: () => () => {},
			signal: controller.signal,
		})
		controller.abort()
		await expect(aborted).resolves.toBe(false)
	} finally {
		vi.useRealTimers()
	}

	const toggles: Array<[boolean, boolean, boolean, string | null]> = [
		[false, false, false, 'Pause'],
		[false, false, true, 'Play'],
		[false, true, true, 'Restart'],
		[true, false, false, null],
	]
	expect(
		toggles.filter(
			([reducedMotion, ended, paused, want]) =>
				landingLoopToggleLabel({ reducedMotion, ended, paused }) !== want,
		),
	).toEqual([])
})
