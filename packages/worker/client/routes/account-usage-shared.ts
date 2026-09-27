import { type AdminPlanName } from '#universal/loader-data.ts'
import { type CreditWalletState } from '#universal/plans.ts'
import { accountCreditsPath } from '#universal/compute-overage.ts'

type CreditsAction = {
	label: 'Add credits' | 'Switch to Pro' | 'Subscribe to Pro'
	href: typeof accountCreditsPath
}

/** Where a capped account goes next; funded wallets and operator plans need nothing. */
export function creditsActionForWallet(
	creditWallet: CreditWalletState,
	plan: AdminPlanName,
	canBuyCredits: boolean,
): CreditsAction | null {
	switch (creditWallet) {
		case 'funded':
			return null
		case 'empty':
			return {
				label: canBuyCredits ? 'Add credits' : 'Subscribe to Pro',
				href: accountCreditsPath,
			}
		case 'none':
			return plan === 'max'
				? null
				: { label: 'Switch to Pro', href: accountCreditsPath }
		default: {
			const exhaustive: never = creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}
