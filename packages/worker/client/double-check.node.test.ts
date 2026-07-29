import { expect, test, vi } from 'vitest'

const mockEventMixin = vi.hoisted(() => ({
	on: vi.fn((type: string, handler: (event: Event) => void) => ({
		type,
		handler,
	})),
}))

vi.mock('#client/event-mixin.ts', () => ({
	on: mockEventMixin.on,
}))

const { createDoubleCheck } = await import('./double-check.ts')

type RecordedMixin = {
	type: string
	handler: (event: Event) => void
}

function invoke(mixin: unknown, event: Event) {
	const recordedMixin = mixin as RecordedMixin
	recordedMixin.handler(event)
}

test('double check button mix requires two clicks, resets on blur, then invokes action', () => {
	const handle = { update: vi.fn() }
	const action = vi.fn()
	const firstClickAction = vi.fn()
	const doubleCheck = createDoubleCheck(handle as never)
	const mix = doubleCheck.getButtonMix({
		on: {
			click: action,
		},
		onFirstClick: firstClickAction,
	})

	expect(mix).toHaveLength(2)
	expect((mix[0] as RecordedMixin).type).toBe('blur')
	expect((mix[1] as RecordedMixin).type).toBe('click')

	const firstClick = {
		preventDefault: vi.fn(),
	} as unknown as Event
	invoke(mix[1], firstClick)

	expect(firstClick.preventDefault).toHaveBeenCalled()
	expect(doubleCheck.doubleCheck).toBe(true)
	expect(action).not.toHaveBeenCalled()
	expect(firstClickAction).toHaveBeenCalledTimes(1)

	invoke(mix[0], new Event('blur'))
	expect(doubleCheck.doubleCheck).toBe(false)
	expect(action).not.toHaveBeenCalled()

	const thirdClick = {
		preventDefault: vi.fn(),
	} as unknown as Event
	invoke(mix[1], thirdClick)

	expect(thirdClick.preventDefault).toHaveBeenCalled()
	expect(doubleCheck.doubleCheck).toBe(true)
	expect(action).not.toHaveBeenCalled()
	expect(firstClickAction).toHaveBeenCalledTimes(2)

	const fourthClick = {
		preventDefault: vi.fn(),
	} as unknown as Event
	invoke(mix[1], fourthClick)

	expect(fourthClick.preventDefault).not.toHaveBeenCalled()
	expect(action).toHaveBeenCalledTimes(1)
	expect(firstClickAction).toHaveBeenCalledTimes(2)
	expect(doubleCheck.doubleCheck).toBe(false)

	const persistentCheck = createDoubleCheck(handle as never)
	const persistentAction = vi.fn()
	const persistentMix = persistentCheck.getButtonMix({
		on: { click: persistentAction },
		resetAfterAction: false,
	})
	invoke(persistentMix[1], { preventDefault: vi.fn() } as unknown as Event)
	invoke(persistentMix[1], { preventDefault: vi.fn() } as unknown as Event)
	expect(persistentAction).toHaveBeenCalledTimes(1)
	expect(persistentCheck.doubleCheck).toBe(true)
})
