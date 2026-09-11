import { type Handle, css } from 'remix/ui'
import * as combobox from 'remix/ui/combobox/primitives'
import { renderIcon } from '#universal/icon.tsx'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	fieldLabelCss,
	getSelectCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

export type ComboboxOption = {
	id: string
	label: string
	/**
	 * Extra text a typed query matches (an id, an alias). Never rendered — a
	 * row is its label alone so a long list scans as names, and an id still
	 * finds its row when someone pastes one.
	 */
	keywords?: Array<string>
}

type ComboboxProps = {
	id: string
	label: string
	/**
	 * Toolbar use: the label is the accessible name only. Sibling toolbar
	 * controls carry `aria-label`, so a visible caption would sit alone above
	 * this field and push it out of line with them.
	 */
	hideLabel?: boolean
	placeholder?: string
	value: string
	options: Array<ComboboxOption>
	disabled?: boolean
	onChange: (value: string) => void
}

/**
 * Kody's labeled combobox on Remix's unstyled combobox primitives. Remix owns
 * filtering, draft and committed values, keyboard interaction, focus timing,
 * popover positioning, and ARIA state; Kody owns the markup and every style,
 * so the field is the same box as `getSelectCss` (chevron included) and the
 * list uses the app's tokens. The styled `remix/ui/combobox` components were
 * not used because each `css()` call is its own cascade layer ordered by first
 * use, so their input styles beat any override applied from a parent.
 *
 * Remix shows its committed value as the input text, so the option value
 * handed to Remix is the label and the id is mapped back on change — the
 * field then reads "sentry", not the package's UUID. Labels must be unique
 * within one combobox (Remix's own exact-match on blur already assumes so).
 */
export function Combobox(handle: Handle<ComboboxProps>) {
	return () => {
		const props = handle.props
		const optionsByLabel = new Map(
			props.options.map((option) => [option.label, option]),
		)
		const selectedLabel = props.value
			? props.options.find((option) => option.id === props.value)?.label
			: undefined
		return (
			<div mix={css(comboboxFieldCss)}>
				<label
					for={props.id}
					mix={css(props.hideLabel ? visuallyHiddenCss : fieldLabelCss)}
				>
					{props.label}
				</label>
				<combobox.Context
					defaultValue={selectedLabel ?? null}
					disabled={props.disabled}
				>
					<div
						mix={[
							css(comboboxRootCss),
							combobox.onComboboxChange((event) => {
								if (event.value == null) return
								const option = optionsByLabel.get(event.value)
								if (option) props.onChange(option.id)
							}),
						]}
					>
						<input
							data-field-ring
							id={props.id}
							defaultValue={selectedLabel}
							placeholder={props.placeholder}
							mix={[css(comboboxInputCss), combobox.input()]}
						/>
						<div mix={[css(comboboxPopoverCss), combobox.popover()]}>
							<div mix={[css(comboboxListCss), combobox.list()]}>
								{props.options.map((option) => (
									<div
										key={option.id}
										mix={[
											css(comboboxOptionCss),
											combobox.option({
												label: option.label,
												searchValue: getOptionSearchValues(option),
												value: option.label,
											}),
										]}
									>
										<span mix={css(comboboxCheckCss)}>
											{renderIcon('check', { size: '1rem' })}
										</span>
										<span mix={css(comboboxOptionLabelCss)}>
											{option.label}
										</span>
									</div>
								))}
							</div>
						</div>
					</div>
				</combobox.Context>
			</div>
		)
	}
}

/**
 * Remix matches a typed query as a prefix of any search value, so a label's
 * later words join the list: "discord" then finds `kody-discord` and
 * "notifier" finds `platform-feedback-discord-notifier`.
 */
function getOptionSearchValues(option: ComboboxOption) {
	const words = option.label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
	return [option.label, ...words.slice(1), ...(option.keywords ?? [])]
}

const comboboxFieldCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const comboboxRootCss = {
	position: 'relative' as const,
	minWidth: 0,
}

const comboboxInputCss = {
	...getSelectCss(),
	cursor: 'text',
	'&:disabled': {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
}

/**
 * Remix's anchor positioning writes `top`/`left` inline on the popover, so
 * the UA's centered `[popover]` box (`inset: 0`, `margin: auto`) has to be
 * reset here for that to take effect.
 */
const comboboxPopoverCss = {
	position: 'fixed' as const,
	inset: 'auto',
	margin: 0,
	padding: 0,
	zIndex: 10,
	display: 'flex',
	flexDirection: 'column' as const,
	minWidth: '12rem',
	maxWidth: `min(24rem, calc(100vw - (${spacing.lg} * 2)))`,
	maxHeight: 'min(18rem, 50dvh)',
	overflow: 'hidden',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	opacity: 0,
	'&:popover-open': {
		opacity: 1,
	},
	'&:not(:popover-open)': {
		pointerEvents: 'none',
	},
	'&::backdrop': {
		background: 'transparent',
	},
}

const comboboxListCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	flex: '1 1 auto',
	minHeight: 0,
	padding: spacing.xs,
	overflow: 'auto',
	overscrollBehavior: 'contain' as const,
	outline: 'none',
	userSelect: 'none' as const,
}

const comboboxOptionCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	// The list is a flex column: without this, rows shrink toward zero once
	// the list scrolls and their text spills onto the next row.
	flexShrink: 0,
	minHeight: '2.25rem',
	paddingInline: spacing.sm,
	borderRadius: radius.sm,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	cursor: 'pointer',
	'&[hidden]': {
		display: 'none',
	},
	'&[data-highlighted="true"]': {
		backgroundColor: colors.primarySoft,
	},
	'--combobox-check-opacity': '0',
	'&[aria-selected="true"]': {
		fontWeight: typography.fontWeight.medium,
		'--combobox-check-opacity': '1',
	},
	'&[aria-disabled="true"]': {
		opacity: 0.5,
		cursor: 'default',
	},
}

const comboboxCheckCss = {
	flex: 'none',
	width: '1rem',
	height: '1rem',
	color: colors.primary,
	opacity: 'var(--combobox-check-opacity)',
}

const comboboxOptionLabelCss = {
	display: 'block',
	flex: '1 1 auto',
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}
