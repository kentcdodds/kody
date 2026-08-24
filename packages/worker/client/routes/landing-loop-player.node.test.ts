import { expect, test, vi } from 'vitest'
import { howKodyWorksTranscriptActs } from './how-kody-works-transcript.ts'
import {
	createLandingLoopPlayer,
	flattenTranscriptActs,
	groupLandingLoopScenes,
	landingLoopChatScrollShouldExplore,
	landingLoopHoldMs,
	landingLoopTeaser,
	landingLoopTeaserBeatCount,
	landingLoopToggleLabel,
	waitLandingLoopHold,
} from './landing-loop-state.ts'

test('homepage loop player pauses for hover and explore, then play resumes and restarts at the end', async () => {
	const beats = flattenTranscriptActs(howKodyWorksTranscriptActs)
	expect(beats[0]).toMatchObject({
		kind: 'act',
		id: 'ask',
		kicker: landingLoopTeaser.kicker,
		title: landingLoopTeaser.title,
		scene: 'desk',
	})
	expect(beats[1]).toMatchObject({
		kind: 'line',
		actId: 'ask',
		scene: 'desk',
		line: { role: 'user', text: landingLoopTeaser.user },
	})
	expect(
		beats.some((beat) => beat.kind === 'act' && beat.id === 'invoke'),
	).toBe(true)
	expect(
		beats.some(
			(beat) =>
				beat.kind === 'act' && beat.id === 'invoke' && beat.scene === 'phone',
		),
	).toBe(true)
	expect(groupLandingLoopScenes(beats).map((group) => group.scene)).toEqual([
		'desk',
		'phone',
	])
	expect(
		beats.some((beat) => beat.kind === 'line' && beat.line.role === 'tools'),
	).toBe(true)

	expect(
		landingLoopChatScrollShouldExplore({
			autoScrolling: true,
			userDriven: true,
			atBottom: false,
		}),
	).toBe(false)
	expect(
		landingLoopChatScrollShouldExplore({
			autoScrolling: false,
			userDriven: false,
			atBottom: false,
		}),
	).toBe(false)
	expect(
		landingLoopChatScrollShouldExplore({
			autoScrolling: false,
			userDriven: true,
			atBottom: true,
		}),
	).toBe(false)
	expect(
		landingLoopChatScrollShouldExplore({
			autoScrolling: false,
			userDriven: true,
			atBottom: false,
		}),
	).toBe(true)

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

	const finisher = createLandingLoopPlayer({
		beatCount: 3,
		reducedMotion: false,
	})
	expect(finisher.revealedCount).toBe(landingLoopTeaserBeatCount)
	expect(finisher.advance()).toEqual({ didAdvance: true, ended: false })
	expect(finisher.revealedCount).toBe(3)
	expect(finisher.advance()).toEqual({ didAdvance: false, ended: true })
	expect(finisher.revealedCount).toBe(3)
	expect(finisher.isEnded()).toBe(true)
	expect(finisher.isPaused()).toBe(true)
	finisher.play()
	expect(finisher.isEnded()).toBe(true)
	expect(finisher.isPaused()).toBe(true)
	finisher.restart()
	expect(finisher.isEnded()).toBe(false)
	expect(finisher.isPaused()).toBe(false)
	expect(finisher.revealedCount).toBe(landingLoopTeaserBeatCount)
	expect(finisher.advance()).toEqual({ didAdvance: true, ended: false })

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
})

test('homepage loop toggle defaults to Pause so the combined icon control can paint on the teaser', () => {
	expect(
		landingLoopToggleLabel({
			reducedMotion: false,
			ended: false,
			paused: false,
		}),
	).toBe('Pause')
	expect(
		landingLoopToggleLabel({
			reducedMotion: false,
			ended: false,
			paused: true,
		}),
	).toBe('Play')
	expect(
		landingLoopToggleLabel({
			reducedMotion: false,
			ended: true,
			paused: true,
		}),
	).toBe('Restart')
	expect(
		landingLoopToggleLabel({
			reducedMotion: true,
			ended: false,
			paused: false,
		}),
	).toBeNull()
})
