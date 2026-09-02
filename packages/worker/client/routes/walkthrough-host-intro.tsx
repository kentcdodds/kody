import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	listWalkthroughHostOptions,
	replaceWalkthroughHost,
	walkthroughHostMarkUrl,
	walkthroughHostSlotLabel,
	type WalkthroughHost,
	type WalkthroughHostPick,
	type WalkthroughHostSlot,
} from '#universal/walkthrough-hosts.ts'
import { colors, radius } from '#universal/styles/tokens.ts'

/**
 * Story setup for the How Kody works transcript and the homepage loop.
 * `sentence` is the guide lead. `picker` is the homepage chooser.
 * Changing a select updates conversation marks through `onHostsChange`.
 * Customizable select is a progressive enhancement; other browsers keep
 * a native select styled as the same inline chip.
 */
export function WalkthroughHostIntro(
	handle: Handle<{
		hosts: WalkthroughHostPick
		onHostsChange: (hosts: WalkthroughHostPick) => void
		variant?: 'sentence' | 'picker'
	}>,
) {
	function changeSlot(slot: WalkthroughHostSlot, hostId: string) {
		const next = replaceWalkthroughHost(handle.props.hosts, slot, hostId)
		if (next === handle.props.hosts) return
		handle.props.onHostsChange(next)
	}

	return () => {
		const hosts = handle.props.hosts
		if (handle.props.variant === 'picker') {
			return (
				<div mix={css(pickerCss)}>
					<p mix={css(pickerLeadCss)}>Choose three agents you use:</p>
					<p mix={css(pickerSentenceCss)}>
						I use {renderHostSelect(hosts, 'coding', changeSlot)} for daily
						coding, {renderHostSelect(hosts, 'invoke', changeSlot)} for phone
						chat, and sometimes {renderHostSelect(hosts, 'notify', changeSlot)}{' '}
						for coding too.
					</p>
				</div>
			)
		}
		return (
			<>
				Let&apos;s say you use {renderHostSelect(hosts, 'coding', changeSlot)}{' '}
				as your regular coding agent,{' '}
				{renderHostSelect(hosts, 'invoke', changeSlot)} as your chat agent on
				your phone, and {renderHostSelect(hosts, 'notify', changeSlot)} as
				another agent you sometimes use. Here&apos;s an example of conversations
				you might have with them when they&apos;re connected to Kody.
			</>
		)
	}
}

function renderHostSelect(
	hosts: WalkthroughHostPick,
	slot: WalkthroughHostSlot,
	onChange: (slot: WalkthroughHostSlot, hostId: string) => void,
	label: string = walkthroughHostSlotLabel(slot),
) {
	const selected = hosts[slot]
	const options = listWalkthroughHostOptions(hosts, slot)
	return (
		<select
			aria-label={label}
			value={selected.id}
			mix={[
				css(selectCss),
				on('change', (event) => {
					if (!(event.currentTarget instanceof HTMLSelectElement)) return
					onChange(slot, event.currentTarget.value)
				}),
			]}
		>
			<button type="button">{renderHostOption(selected)}</button>
			{options.map((host) => (
				<option
					key={host.id}
					value={host.id}
					selected={host.id === selected.id}
				>
					{renderHostOption(host)}
				</option>
			))}
		</select>
	)
}

function renderHostOption(host: WalkthroughHost) {
	return (
		<span mix={css(optionInnerCss)}>
			<span
				mix={css(optionMarkCss)}
				style={{
					'--chip-icon': `url("${walkthroughHostMarkUrl(host)}")`,
				}}
				aria-hidden="true"
			></span>
			{host.label}
		</span>
	)
}

const pickerCss = {
	display: 'grid',
	gap: '0.7rem',
}

const pickerLeadCss = {
	margin: 0,
	color: colors.text,
	fontWeight: 650,
}

const pickerSentenceCss = {
	margin: 0,
	lineHeight: 1.7,
}

const nativeSelectCss = {
	appearance: 'none' as const,
	WebkitAppearance: 'none' as const,
	paddingRight: '1.35em',
	backgroundImage: 'var(--select-chevron)',
	backgroundRepeat: 'no-repeat',
	backgroundPosition: 'right 0.35em center',
	backgroundSize: '0.75em',
}

const selectCss = {
	display: 'inline-flex',
	alignItems: 'center',
	verticalAlign: 'middle' as const,
	maxWidth: '100%',
	minHeight: '24px',
	margin: '0 0.15em',
	padding: '0.15em 0.5em',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	color: colors.text,
	font: 'inherit',
	fontWeight: 650,
	lineHeight: 1,
	cursor: 'pointer',
	'&:hover, &:focus-visible': {
		borderColor: colors.primary,
		color: colors.primaryText,
	},
	'@supports (appearance: base-select)': {
		appearance: 'base-select' as const,
		'& > button': {
			display: 'inline-flex',
			alignItems: 'center',
			minHeight: '24px',
			margin: 0,
			padding: '0.15em 0',
			border: 'none',
			background: 'transparent',
			color: 'inherit',
			font: 'inherit',
			fontWeight: 'inherit',
			lineHeight: 'inherit',
			cursor: 'pointer',
		},
		'&::picker-icon': {
			width: '0.7em',
			height: '0.7em',
			alignSelf: 'center',
			translate: '0 -0.12em',
			color: 'currentColor',
			opacity: 0.7,
		},
		'&::picker(select)': {
			appearance: 'base-select' as const,
			marginTop: '0.35rem',
			padding: '0.35rem',
			border: `1px solid ${colors.border}`,
			borderRadius: radius.lg,
			backgroundColor: colors.surface,
			color: colors.text,
		},
		'& option': {
			padding: '0.4rem 0.55rem',
			borderRadius: radius.md,
			cursor: 'pointer',
		},
		'& option:hover, & option:checked': {
			backgroundColor: colors.primarySoftest,
		},
		'& option::checkmark': {
			display: 'none',
		},
	},
	'@supports not (appearance: base-select)': nativeSelectCss,
}

const optionInnerCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.35em',
}

const optionMarkCss = {
	width: '0.85em',
	height: '0.85em',
	flex: 'none',
	background: 'currentColor',
	maskImage: 'var(--chip-icon)',
	maskPosition: 'center',
	maskSize: 'contain',
	maskRepeat: 'no-repeat',
	WebkitMaskImage: 'var(--chip-icon)',
	WebkitMaskPosition: 'center',
	WebkitMaskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
}
