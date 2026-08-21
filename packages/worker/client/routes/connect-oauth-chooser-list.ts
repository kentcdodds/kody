import { matchesSearchQuery } from '#client/search-filter.ts'
import { spacing } from '#universal/styles/tokens.ts'

/** Filter input appears only when the chooser has more options than this. */
export const connectOauthChooserFilterMinOptions = 6

/**
 * Default ProviderMark well size used by chooser rows. The list viewport is
 * 2.5 of these rows so overflow is obvious even when scrollbars are
 * overlay/hidden.
 */
export const connectOauthChooserOptionMarkSize = '3rem'

/**
 * Taller of the mark and the label+detail stack, plus inset-card padding
 * and borders. Using only the mark left the third card's peek as empty
 * padding, so overlay-scrollbar users could not tell the list scrolled.
 */
export const connectOauthChooserOptionRowHeight = `calc(max(${connectOauthChooserOptionMarkSize}, calc((1em * var(--line-height-body) * 2) + ${spacing.xs})) + (${spacing.md} * 2) + 2px)`

/**
 * `2.5 * (row + gap) - gap`: two full cards, half of a third, and the gaps
 * between them.
 */
export const connectOauthChooserListMaxHeight = `calc(2.5 * (${connectOauthChooserOptionRowHeight} + ${spacing.sm}) - ${spacing.sm})`

export function filterConnectOauthChooserOptions<
	T extends { label: string; detail: string; providerKey: string },
>(options: ReadonlyArray<T>, query: string): Array<T> {
	return options.filter((option) =>
		matchesSearchQuery(query, [
			option.label,
			option.detail,
			option.providerKey,
		]),
	)
}
