import { type Handle } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'

export function createOnboardingNextConfirmation(handle: Handle<unknown>) {
	const confirmation = createDoubleCheck(handle as unknown as Handle)

	return {
		get armed() {
			return confirmation.doubleCheck
		},
		getButtonMix(input: { confirm: boolean; onNext: () => void }) {
			return input.confirm
				? confirmation.getButtonMix({
						on: { click: input.onNext },
					})
				: [on('click', input.onNext)]
		},
		getLabel(confirm: boolean) {
			return confirm && confirmation.doubleCheck
				? 'Not connected — continue anyway?'
				: 'Next'
		},
	}
}
