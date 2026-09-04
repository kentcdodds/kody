import { type Handle, css } from 'remix/ui'
import { isKnownProviderIconId, ProviderIcon } from '#client/provider-icons.tsx'
import {
	type OnboardingFeaturedMcpServerId,
	type OnboardingServiceChoice,
	onboardingFeaturedMcpServerById,
	onboardingNotListedPromptServices,
	onboardingNotListedServiceId,
	onboardingServiceImageIconSrc,
	onboardingServiceLabel,
} from '#universal/onboarding-mcp-chooser.ts'
import {
	onboardingNotListedAnything,
	onboardingServiceHref,
} from '#universal/onboarding-process.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

export function ServicePickerMark(
	handle: Handle<{
		service: string
		label?: string
		testId?: string
	}>,
) {
	return () => {
		const label = handle.props.label ?? handle.props.service
		if (handle.props.service === onboardingNotListedServiceId) {
			return (
				<span
					mix={css(pickerMarkCss)}
					aria-hidden="true"
					data-testid={handle.props.testId}
				>
					<svg
						viewBox="0 0 24 24"
						width="22"
						height="22"
						fill="currentColor"
						aria-hidden="true"
					>
						<circle cx="6" cy="12" r="1.6" />
						<circle cx="12" cy="12" r="1.6" />
						<circle cx="18" cy="12" r="1.6" />
					</svg>
				</span>
			)
		}
		const imageSrc = onboardingServiceImageIconSrc(handle.props.service)
		if (imageSrc) {
			return (
				<span
					mix={css(chipIconCss)}
					style={{ '--chip-icon': `url("${imageSrc}")` }}
					aria-hidden="true"
					data-testid={handle.props.testId}
				/>
			)
		}
		if (isKnownProviderIconId(handle.props.service)) {
			return (
				<span
					mix={css(pickerMarkCss)}
					aria-hidden="true"
					data-testid={handle.props.testId}
				>
					<ProviderIcon providerId={handle.props.service} size="28" />
				</span>
			)
		}
		return (
			<span
				mix={css(letterMarkCss)}
				aria-hidden="true"
				data-testid={handle.props.testId}
			>
				{label.slice(0, 1)}
			</span>
		)
	}
}

function ServicePickerCardLink(
	handle: Handle<{
		id: OnboardingServiceChoice
	}>,
) {
	return () => {
		const label = onboardingServiceLabel(handle.props.id)
		return (
			<a
				href={onboardingServiceHref(handle.props.id)}
				data-testid={`onboarding-service-${handle.props.id}`}
				data-prevent-scroll-reset=""
				mix={css(pickerCardCss)}
			>
				<ServicePickerMark service={handle.props.id} label={label} />
				<strong>{label}</strong>
			</a>
		)
	}
}

/**
 * Step 2 index: shuffled official MCP remotes plus a Show more rule.
 * Every chip, including overflow and BYO, is a `/onboarding/step-2/:service`
 * link. This is not a hosted-OAuth connect wizard.
 */
export function OnboardingServicePicker(
	handle: Handle<{
		featuredIds: ReadonlyArray<OnboardingFeaturedMcpServerId>
		overflowIds: ReadonlyArray<OnboardingFeaturedMcpServerId>
	}>,
) {
	return () => {
		const { featuredIds, overflowIds } = handle.props
		const overflowChips = overflowIds.flatMap((id) => {
			const server = onboardingFeaturedMcpServerById(id)
			if (!server) return []
			return [server]
		})
		return (
			<div data-testid="onboarding-service-picker" mix={css(installLayoutCss)}>
				<ul
					aria-label="Services with an official MCP path"
					mix={css(pickerGridCss)}
				>
					{featuredIds.map((id) => (
						<li key={id}>
							<ServicePickerCardLink id={id} />
						</li>
					))}
				</ul>
				<details
					data-testid="onboarding-service-show-more"
					mix={css(showMoreCss)}
				>
					<summary>Show more</summary>
					<div>
						<p mix={css(anythingCss)}>{onboardingNotListedAnything}</p>
						<ul
							aria-label="More services that flavor the prompt"
							mix={css(pickerGridCss)}
						>
							{overflowChips.map((server) => (
								<li key={server.id}>
									<ServicePickerCardLink id={server.id} />
								</li>
							))}
							{onboardingNotListedPromptServices.map((service) => (
								<li key={service.id}>
									<ServicePickerCardLink id={service.id} />
								</li>
							))}
							<li key={onboardingNotListedServiceId}>
								<ServicePickerCardLink id={onboardingNotListedServiceId} />
							</li>
						</ul>
					</div>
				</details>
			</div>
		)
	}
}

const installLayoutCss = {
	display: 'grid',
	gap: '1.15rem',
}

const pickerGridCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	alignItems: 'stretch',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(10.5rem, 100%), 1fr))',
	gap: '0.75rem',
}

const pickerCardCss = {
	display: 'grid',
	justifyItems: 'center',
	alignContent: 'center',
	gap: '0.55rem',
	width: '100%',
	height: '100%',
	minWidth: 0,
	padding: '1.05rem 0.85rem',
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	color: colors.text,
	cursor: 'pointer',
	textDecoration: 'none',
	boxSizing: 'border-box' as const,
	textAlign: 'center' as const,
	font: `650 0.98rem/1.25 ${typography.fontFamilyBody}`,
	transition: `border-color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			transform: 'translateY(-2px)',
		},
	},
	'&:active': { transform: 'translateY(0)' },
	'@media (prefers-reduced-motion: reduce)': {
		transition: `border-color 160ms ${transitions.easeOut}`,
		'&:hover': { transform: 'none' },
		'&:active': { transform: 'none' },
	},
}

const pickerMarkCss = {
	display: 'grid',
	placeItems: 'center',
	flex: 'none',
	width: '1.75rem',
	height: '1.75rem',
	color: colors.text,
	'& svg': {
		fill: 'currentColor',
	},
	'& svg :is(path, circle, rect)': {
		fill: 'inherit',
	},
	'& svg [fill="#fff"], & svg [fill="#FFF"], & svg [fill="#ffffff"], & svg [fill="white"]':
		{
			fill: colors.background,
		},
}

const chipIconCss = {
	...pickerMarkCss,
	backgroundColor: colors.text,
	maskImage: 'var(--chip-icon)',
	maskPosition: 'center',
	maskSize: 'contain',
	maskRepeat: 'no-repeat',
	WebkitMaskImage: 'var(--chip-icon)',
	WebkitMaskPosition: 'center',
	WebkitMaskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
}

const letterMarkCss = {
	...pickerMarkCss,
	borderRadius: '999px',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	font: `700 0.85rem/1 ${typography.fontFamilyBody}`,
	color: colors.textMuted,
}

const anythingCss = {
	margin: 0,
	color: colors.text,
	fontWeight: 650,
	maxWidth: '68ch',
}

const showMoreCss = {
	margin: 0,
	'& > summary': {
		display: 'grid',
		gridTemplateColumns: '1fr auto 1fr',
		alignItems: 'center',
		columnGap: '0.85rem',
		width: '100%',
		cursor: 'pointer',
		listStyle: 'none',
		font: `650 0.9rem/1 ${typography.fontFamilyBody}`,
		color: colors.textMuted,
		'&::-webkit-details-marker': { display: 'none' },
		'&::marker': { content: 'none' },
		'&::before, &::after': {
			content: '""',
			height: '1px',
			backgroundColor: colors.border,
		},
	},
	[hoverMq]: {
		'& > summary:hover': { color: colors.text },
	},
	'&[open] > summary': {
		marginBottom: '1rem',
	},
	'& > :not(summary)': {
		display: 'grid',
		gap: '1.15rem',
	},
}
