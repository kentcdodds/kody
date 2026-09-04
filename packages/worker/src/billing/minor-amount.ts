/**
 * Stripe amounts are integers in each currency's smallest unit. Most
 * currencies follow ISO 4217 minor units (which `Intl` knows), but Stripe
 * represents these four with two decimals even though ISO says zero.
 */
const stripeTwoDecimalOverrides = new Set(['HUF', 'ISK', 'TWD', 'UGX'])

function resolveMinorUnitDigits(currency: string) {
	if (stripeTwoDecimalOverrides.has(currency)) return 2
	try {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency,
		}).resolvedOptions().maximumFractionDigits
	} catch {
		return 2
	}
}

/**
 * Formats a Stripe minor-unit amount (for example `1234` USD) as a display
 * string (`$12.34`). Unknown currency codes fall back to `12.34 XXX`.
 */
export function formatStripeMinorAmount(amountMinor: number, currency: string) {
	const code = currency.trim().toUpperCase()
	const digits = resolveMinorUnitDigits(code)
	const major = amountMinor / 10 ** digits
	try {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: code,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(major)
	} catch {
		return `${major.toFixed(digits)} ${code}`
	}
}
