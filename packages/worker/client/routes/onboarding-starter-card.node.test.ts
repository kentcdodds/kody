import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingStarterCard } from './onboarding-starter-card.tsx'

test('advanced-row Copy prompt keeps pill hover lift and reveals its tooltip', async () => {
	const html = await renderToString(
		jsx(OnboardingStarterCard, {
			loggedIn: true,
			variant: 'row',
			listing: {
				id: 'listing-1',
				kodyId: 'demo',
				name: 'Demo',
				description: 'A demo package',
				iconUrl: '/icon.png',
				tags: [],
				viewerInstall: {
					status: 'installed',
					targetName: '@me/demo',
					agentPrompt: 'Finish setup for this package.',
					packageId: 'pkg-1',
					listingAhead: false,
					listingAheadPrompt: null,
				},
			},
		}),
	)

	expect(html).toContain('data-testid="onboarding-starter-copy-listing-1"')
	expect(html).toMatch(
		/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*&:not\(:disabled\):hover \{[\s\S]*translateY\(-1px\)[\s\S]*&:hover \[role="tooltip"\] \{\s*opacity: 1;\s*visibility: visible;/,
	)
})
