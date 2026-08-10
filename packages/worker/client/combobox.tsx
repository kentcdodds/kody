import { type Handle, css } from 'remix/ui'
import {
	Combobox as RemixCombobox,
	ComboboxOption as RemixComboboxOption,
} from 'remix/ui/combobox'
import { onComboboxChange } from 'remix/ui/combobox/primitives'
import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'
import { fieldLabelCss, inputCss } from '#universal/styles/style-primitives.ts'

export type ComboboxOption = {
	id: string
	label: string
	description?: string | null
}

type ComboboxProps = {
	id: string
	label: string
	placeholder?: string
	value: string
	options: Array<ComboboxOption>
	disabled?: boolean
	onChange: (value: string) => void
}

/**
 * Kody's labeled, design-system adapter for Remix's accessible combobox.
 * Remix owns filtering, draft and committed values, keyboard interaction,
 * focus timing, popover behavior, and ARIA state.
 */
export function Combobox(handle: Handle<ComboboxProps>) {
	return () => {
		const props = handle.props
		return (
			<div mix={css(comboboxFieldCss)}>
				<label for={props.id} mix={css(fieldLabelCss)}>
					{props.label}
				</label>
				<RemixCombobox
					inputId={props.id}
					defaultValue={props.value || null}
					disabled={props.disabled}
					placeholder={props.placeholder}
					mix={[
						css(comboboxRootCss),
						onComboboxChange((event) => {
							if (event.value == null) return
							props.onChange(event.value)
						}),
					]}
				>
					{props.options.map((option) => (
						<RemixComboboxOption
							key={option.id}
							label={option.label}
							searchValue={[option.label, option.description ?? '', option.id]}
							value={option.id}
						>
							<span mix={css(comboboxOptionContentCss)}>
								<span>{option.label}</span>
								{option.description ? (
									<span mix={css(comboboxDescriptionCss)}>
										{option.description}
									</span>
								) : null}
							</span>
						</RemixComboboxOption>
					))}
				</RemixCombobox>
			</div>
		)
	}
}

const comboboxFieldCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const comboboxRootCss = {
	position: 'relative' as const,
	'& input[role="combobox"]': {
		...inputCss,
		minHeight: 'auto',
		boxShadow: 'none',
	},
	'& [popover]': {
		zIndex: 10,
		maxHeight: '18rem',
		overflowY: 'auto' as const,
		borderRadius: radius.md,
		border: `1px solid ${colors.border}`,
		backgroundColor: colors.surface,
		boxShadow: shadows.md,
		padding: spacing.xs,
		color: colors.text,
	},
	'& [role="option"]': {
		borderRadius: radius.md,
		color: colors.text,
		'&[data-highlighted="true"], &:hover': {
			backgroundColor: colors.primarySoftest,
		},
	},
}

const comboboxOptionContentCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const comboboxDescriptionCss = {
	fontSize: 'var(--font-size-sm)',
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
}
