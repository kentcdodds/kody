import { type Handle, css } from 'remix/ui'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import {
	onboardingGuideEntity,
	onboardingGuideHref,
	onboardingTeachConcepts,
} from '#universal/onboarding-process.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'

export function OnboardingTeachPrompts(_handle: Handle) {
	return () => (
		<div data-testid="onboarding-teach-prompts" mix={css(listCss)}>
			<p mix={css(guidePointerCss)} data-testid="onboarding-guide-pointer">
				Agents retrieve{' '}
				<code>{`search({ entity: "${onboardingGuideEntity}" })`}</code>
				{' · '}
				<a href={onboardingGuideHref} mix={css(guideLinkCss)}>
					Onboarding guide
				</a>
			</p>
			{onboardingTeachConcepts.map((item) => (
				<CopyCard
					key={item.id}
					label={item.title}
					value={item.prompt}
					copyLabel={`Copy ${item.title} prompt`}
				/>
			))}
		</div>
	)
}

const listCss = {
	display: 'grid',
	gap: '0.85rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}

const guidePointerCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	'& code': {
		font: '500 0.88em ui-monospace, "SF Mono", Menlo, monospace',
		color: colors.text,
		backgroundColor: colors.background,
		border: `1px solid ${colors.border}`,
		borderRadius: '6px',
		padding: '0.1em 0.4em',
	},
}

const guideLinkCss = {
	...primaryLinkCss,
	fontWeight: 600,
}
