import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from '#client/styles/style-primitives.ts'

type CopyTextButtonProps = {
	value: string
	idleLabel?: string
	variant?: 'primary' | 'secondary'
}

/**
 * Button that copies `value` to the clipboard and shows transient
 * "Copied" / "Copy failed" feedback before returning to the idle label.
 */
export function CopyTextButton(handle: Handle<CopyTextButtonProps>) {
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let resetTimerId: ReturnType<typeof setTimeout> | null = null

	async function copyValue() {
		try {
			await writeClipboardText(handle.props.value)
			copyState = 'copied'
		} catch {
			copyState = 'error'
		}
		handle.update()
		if (resetTimerId != null) clearTimeout(resetTimerId)
		resetTimerId = setTimeout(() => {
			resetTimerId = null
			if (handle.signal.aborted) return
			copyState = 'idle'
			handle.update()
		}, 2000)
	}

	return () => (
		<button
			type="button"
			mix={[
				css(
					handle.props.variant === 'secondary'
						? getSecondaryButtonCss()
						: getPrimaryButtonCss(),
				),
				on('click', () => void copyValue()),
			]}
		>
			{copyState === 'copied'
				? 'Copied'
				: copyState === 'error'
					? 'Copy failed'
					: (handle.props.idleLabel ?? 'Copy')}
		</button>
	)
}
