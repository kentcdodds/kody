import { type Handle } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'

export function createOnboardingNextConfirmation(handle: Handle<unknown>) {
	const confirmation = createDoubleCheck(handle as unknown as Handle)

	function labels(confirm: boolean) {
		if (confirm && confirmation.doubleCheck) {
			return {
				full: 'Not connected — continue anyway?',
				terse: 'Continue?',
			}
		}
		return { full: 'Next', terse: 'Next' }
	}

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
			return labels(confirm).full
		},
		/**
		 * Wide navs keep the warning. A narrow nav uses the terse label so the
		 * button still fits beside Back; the accessible name stays the full one.
		 */
		getLabels(confirm: boolean) {
			return labels(confirm)
		},
	}
}
