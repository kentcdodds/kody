import {
	type AccountUsageComputeOverage,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import { type CreditWalletState } from '#universal/plans.ts'
import { accountCreditsPath } from '#universal/compute-overage.ts'
import { formatMicroUsd } from '#universal/credits.ts'

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

export function computeAccountUsageOverageNotice(
	overage: AccountUsageComputeOverage,
	plan: AdminPlanName,
	canBuyCredits: boolean,
): {
	title: string
	body: string
	tone: 'info' | 'warn'
	action: CreditsAction | null
} | null {
	const approaching = overage.meters.some(
		(meter) => meter.overEightyPercent && meter.percentOfLimit < 1,
	)
	switch (overage.creditsStatus) {
		case 'debiting_credits':
			return {
				title: 'Using credits',
				body: `Usage above this month's include is debiting your credits: ${formatMicroUsd(overage.creditsCostMicroUsd)} so far.`,
				tone: 'info',
				action: null,
			}
		case 'add_credits':
			return {
				title: "Over this month's include",
				body: canBuyCredits
					? 'Add credits to lift rate caps. Usage above the include then debits credits.'
					: 'Subscribe to Pro to add credits and lift rate caps.',
				tone: 'warn',
				action: creditsActionForWallet('empty', plan, canBuyCredits),
			}
		case 'switch_to_pro':
			return {
				title: "Over this month's include",
				body:
					plan === 'free'
						? 'Switch to Pro for a larger include and prepaid credits.'
						: 'Usage above the include is not charged on your plan. Switch to Pro to add credits.',
				tone: 'warn',
				action: { label: 'Switch to Pro', href: accountCreditsPath },
			}
		case 'not_charged':
			return null
		case 'within_include':
			if (!approaching) return null
			return {
				title: 'Approaching compute includes',
				body:
					overage.creditWallet === 'funded'
						? "You are over 80% of this month's Worker compute or Rows read include. Usage above it debits your credits."
						: "You are over 80% of this month's Worker compute or Rows read include.",
				tone: 'info',
				action: creditsActionForWallet(
					overage.creditWallet,
					plan,
					canBuyCredits,
				),
			}
		default: {
			const exhaustive: never = overage.creditsStatus
			throw new Error(`Unknown credits status: ${String(exhaustive)}`)
		}
	}
}
