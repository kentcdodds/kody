import { type Handle } from 'remix/component'

type BlurHandler = (event: FocusEvent) => void
type ClickHandler = (event: MouseEvent) => void

type ButtonLikeProps = {
	on?: {
		blur?: BlurHandler
		click?: ClickHandler
	}
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
		getButtonProps<Props extends ButtonLikeProps>(props?: Props): Props {
			const buttonProps = props ?? ({} as Props)

			const onBlur: BlurHandler = () => {
				setDoubleCheck(false)
			}

			const onClick: ClickHandler = (event) => {
				if (!doubleCheck) {
					event.preventDefault()
					setDoubleCheck(true)
					return
				}

				buttonProps.on?.click?.(event)
				setDoubleCheck(false)
			}

			return {
				...buttonProps,
				on: {
					...buttonProps.on,
					blur: callAll(onBlur, buttonProps.on?.blur),
					click: onClick,
				},
			}
		},
	}
}
