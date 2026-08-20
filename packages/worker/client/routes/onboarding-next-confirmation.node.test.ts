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

const { createOnboardingNextConfirmation } =
	await import('./onboarding-next-confirmation.ts')

type RecordedMixin = {
	type: string
	handler: (event: Event) => void
}

test('unconnected onboarding Next warns once before advancing', () => {
	const handle = { update: vi.fn() }
	const onNext = vi.fn()
	const confirmation = createOnboardingNextConfirmation(handle as never)
	const mix = confirmation.getButtonMix({ confirm: true, onNext })
	const click = mix[1] as RecordedMixin

	const firstClick = { preventDefault: vi.fn() } as unknown as Event
	click.handler(firstClick)
	expect(firstClick.preventDefault).toHaveBeenCalledOnce()
	expect(confirmation.armed).toBe(true)
	expect(confirmation.getLabel(true)).not.toBe('Next')
	expect(onNext).not.toHaveBeenCalled()

	const secondClick = { preventDefault: vi.fn() } as unknown as Event
	click.handler(secondClick)
	expect(secondClick.preventDefault).not.toHaveBeenCalled()
	expect(onNext).toHaveBeenCalledOnce()
	expect(confirmation.armed).toBe(false)

	const connectedNext = vi.fn()
	const connectedMix = confirmation.getButtonMix({
		confirm: false,
		onNext: connectedNext,
	})
	expect(connectedMix).toHaveLength(1)
	;(connectedMix[0] as RecordedMixin).handler(new Event('click'))
	expect(connectedNext).toHaveBeenCalledOnce()
	expect(confirmation.getLabel(false)).toBe('Next')
})
