import { type Handle, css, ref, type CSSMixinDescriptor } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

export type PasswordRevealInputProps = {
	id?: string
	name?: string
	required?: boolean
	disabled?: boolean
	readOnly?: boolean
	autoComplete?: string
	autocomplete?: string
	autoFocus?: boolean
	placeholder?: string
	value?: string
	defaultValue?: string
	minLength?: number
	'data-field'?: string
	'data-field-ring'?: boolean | string
	'data-testid'?: string
	'data-1p-ignore'?: boolean
	'data-lpignore'?: string
	'aria-invalid'?: 'true' | 'false' | boolean
	'aria-describedby'?: string
	// Callers pass `css(...)` and `on('input', …)` the same way as raw inputs.
	mix?: unknown
	/**
	 * Noun used in the toggle's accessible name, e.g. `"password"` →
	 * "Show password" / "Hide password". Secrets use `"secret value"`.
	 */
	revealNoun?: string
	/**
	 * Controlled reveal. When omitted, this component owns reveal state.
	 * Parents that must hide again on selection change (secrets editor) pass
	 * these; login and most forms leave them unset.
	 */
	revealed?: boolean
	onRevealedChange?: (revealed: boolean) => void
}

/**
 * Password (or secret-value) input with an accessible Show/Hide toggle.
 *
 * Uncontrolled callers (login) stay uncontrolled: flipping `type` can clear
 * the DOM value, so the toggle snapshots and restores it via a ref instead of
 * switching the field to a controlled `value` (which broke FormData login).
 * The toggle is `type="button"` so it never submits; without JS it is inert
 * and the field stays `type="password"`.
 */
export function PasswordRevealInput(handle: Handle<PasswordRevealInputProps>) {
	let internalRevealed = false
	let inputEl: HTMLInputElement | null = null

	return () => {
		const {
			revealNoun = 'password',
			revealed: controlledRevealed,
			onRevealedChange,
			mix: inputMix,
			...inputProps
		} = handle.props
		const revealed =
			controlledRevealed === undefined ? internalRevealed : controlledRevealed
		const showLabel = `Show ${revealNoun}`
		const hideLabel = `Hide ${revealNoun}`
		const inputType = revealed ? 'text' : 'password'

		return (
			<div mix={css(wrapCss)}>
				{/*
				 * Remix discriminates AccessibleInputHTMLProps by `type`, so a
				 * `"text" | "password"` union is not assignable. Runtime still
				 * toggles the attribute on one element (no remount).
				 */}
				<input
					{...({
						...inputProps,
						type: inputType,
						mix: [
							ref((node, signal) => {
								inputEl = node instanceof HTMLInputElement ? node : null
								signal.addEventListener('abort', () => {
									if (inputEl === node) inputEl = null
								})
							}),
							inputPadCss,
							inputMix,
						],
					} as Record<string, unknown>)}
				/>
				<button
					type="button"
					aria-label={revealed ? hideLabel : showLabel}
					aria-pressed={revealed ? 'true' : 'false'}
					title={revealed ? hideLabel : showLabel}
					mix={[
						on('click', (event) => {
							event.preventDefault()
							const snapshot = inputEl?.value ?? ''
							const next = !revealed
							onRevealedChange?.(next)
							// Controlled parents own the re-render. Updating here
							// would paint from stale props before the parent flushes.
							if (controlledRevealed === undefined) {
								internalRevealed = next
								handle.update()
							}
							// Restore after the type attribute paints — flipping
							// password↔text can clear the DOM value.
							handle.queueTask(() => {
								if (inputEl && inputProps.value === undefined) {
									inputEl.value = snapshot
								}
							})
						}),
						css(toggleButtonCss),
					]}
				>
					{revealed ? 'Hide' : 'Show'}
				</button>
			</div>
		)
	}
}

const wrapCss = {
	position: 'relative' as const,
	display: 'flex',
	alignItems: 'center',
	width: '100%',
	minWidth: 0,
}

const inputPadCss: CSSMixinDescriptor = css({
	// Room for the absolute Show/Hide control. Callers' input styles apply
	// first; this padding-right wins so the value never runs under the button.
	paddingRight: '4.5rem',
})

const toggleButtonCss = {
	position: 'absolute' as const,
	right: spacing.sm,
	top: '50%',
	transform: 'translateY(-50%)',
	background: 'none',
	border: 'none',
	borderRadius: '999px',
	padding: spacing.xs,
	width: '3.5rem',
	height: '2rem',
	color: colors.text,
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontSize: '0.75rem',
	fontWeight: 600,
	'&:hover': {
		background: colors.primarySoft,
	},
}
