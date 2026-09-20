import { type IconName } from '#universal/icon.tsx'

/**
 * Homepage “Trigger it / No inference” example cards. Each tile is a
 * quiet same-origin docs link (pointer + focus ring, no CTA chrome).
 */
export const landingFactoryBeats = [
	{
		trigger: 'Cron',
		title: 'Flake Hunter',
		icon: 'target',
		slug: 'flake-hunter',
	},
	{
		trigger: 'Webhook',
		title: 'Sentry Issues',
		icon: 'warning-triangle',
		slug: 'sentry-issues',
	},
	{
		trigger: 'Email',
		title: 'Agent inbox',
		icon: 'mail',
		slug: 'agent-inbox',
	},
	{
		trigger: 'Event',
		title: 'Purchase thanks',
		icon: 'heart',
		slug: 'purchase-thanks',
	},
] as const satisfies ReadonlyArray<{
	trigger: string
	title: string
	icon: IconName
	slug: string
}>
