import { type AdminPlanName } from '#universal/loader-data.ts'
import { type CreditWalletState } from '#universal/plans.ts'

type CreditsAction = {
	label: 'Add credits' | 'Switch to Pro' | 'Subscribe to Pro'
	href: string
}

/** Where a capped account goes next; funded wallets and operator plans need nothing. */
export function creditsActionForWallet(
	creditWallet: CreditWalletState,
	plan: AdminPlanName,
	canBuyCredits: boolean,
	creditsHref: string,
): CreditsAction | null {
	switch (creditWallet) {
		case 'funded':
			return null
		case 'empty':
			return {
				label: canBuyCredits ? 'Add credits' : 'Subscribe to Pro',
				href: creditsHref,
			}
		case 'none':
			return plan === 'max'
				? null
				: { label: 'Switch to Pro', href: creditsHref }
		default: {
			const exhaustive: never = creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}
