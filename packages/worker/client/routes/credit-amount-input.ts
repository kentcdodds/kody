import { formatCents, formatMicroUsd } from '#universal/credits.ts'

/**
 * Dollar text from an amount field as whole cents. Blank is `null`;
 * anything that is not a plain dollar amount (at most two decimals) is
 * `NaN`, which the shared credit validators reject.
 */
export function parseDollarsToCents(text: string): number | null {
	const trimmed = text.trim().replace(/^\$/, '').replaceAll(',', '')
	if (trimmed === '') return null
	if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return Number.NaN
	const [whole = '0', fraction = ''] = trimmed.split('.')
	return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** Cents as the text an amount field starts from (`25`, `12.50`). */
export function formatCentsForInput(cents: number | null): string {
	if (cents === null) return ''
	return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)
}

/** Pack button label: whole dollars drop the cents (`$25`). */
export function formatWholeDollars(cents: number): string {
	return cents % 100 === 0
		? `$${(cents / 100).toLocaleString('en-US')}`
		: formatCents(cents)
}

/** Ledger amount with an explicit sign for credits. */
export function formatSignedMicroUsd(microUsd: number): string {
	return microUsd > 0
		? `+${formatMicroUsd(microUsd)}`
		: formatMicroUsd(microUsd)
}
