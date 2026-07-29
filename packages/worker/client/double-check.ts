import { type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'

type BlurHandler = (event: FocusEvent) => void
type ClickHandler = (event: MouseEvent) => void

type ButtonLikeProps = {
	on?: {
		blur?: BlurHandler
		click?: ClickHandler
	}
	onFirstClick?: ClickHandler
	resetAfterAction?: boolean
	[key: string]: unknown
}

function callAll<Event>(
	...handlers: Array<((event: Event) => void) | undefined>
) {
	return (event: Event) => {
		for (const handler of handlers) {
			handler?.(event)
		}
	}
}

export function createDoubleCheck(handle: Handle) {
	let doubleCheck = false

	function setDoubleCheck(nextValue: boolean) {
		if (doubleCheck === nextValue) return
		doubleCheck = nextValue
		handle.update()
	}

	return {
		get doubleCheck() {
			return doubleCheck
		},
		reset() {
			setDoubleCheck(false)
		},
		getButtonMix<Props extends ButtonLikeProps>(props?: Props) {
			const buttonProps = props ?? ({} as Props)

			const onBlur: BlurHandler = () => {
				setDoubleCheck(false)
			}

			const onClick: ClickHandler = (event) => {
				if (!doubleCheck) {
					event.preventDefault()
					buttonProps.onFirstClick?.(event)
					setDoubleCheck(true)
					return
				}

				buttonProps.on?.click?.(event)
				if (buttonProps.resetAfterAction !== false) {
					setDoubleCheck(false)
				}
			}

			return [
				on('blur', (event) => callAll(onBlur, buttonProps.on?.blur)(event)),
				on('click', onClick),
			]
		},
	}
}
