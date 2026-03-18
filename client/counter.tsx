import { type Handle } from 'remix/component'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from './styles/tokens.ts'

type CounterSetup = {
	initial?: number
}

export function Counter(handle: Handle, setup: CounterSetup = {}) {
	let count = setup.initial ?? 0

	function increment() {
		count += 1
		handle.update()
	}

	return () => (
		<button
			type="button"
			css={{
				padding: `${spacing.sm} ${spacing.lg}`,
				borderRadius: radius.full,
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.primary,
				color: colors.onPrimary,
				fontSize: typography.fontSize.base,
				fontWeight: typography.fontWeight.semibold,
				cursor: 'pointer',
				transition: `transform ${transitions.fast}, background-color ${transitions.normal}`,
				'&:hover': {
					backgroundColor: colors.primaryHover,
					transform: 'translateY(-1px)',
				},
				'&:active': {
					backgroundColor: colors.primaryActive,
					transform: 'translateY(0)',
				},
			}}
			on={{ click: increment }}
		>
			Count: {count}
		</button>
	)
}
