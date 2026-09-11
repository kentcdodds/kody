import { type RemixNode } from 'remix/ui'

/** Decorative link icon for prose heading permalinks. */
function renderHeadingAnchorIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
		</svg>
	)
}

/**
 * Section permalink that sits beside heading text (not around it) so an
 * inline markdown link in the heading cannot nest inside this `<a>`.
 * `proseCss` stretches the control over the heading and hangs the icon.
 */
export function renderMarkdownHeadingAnchor(
	key: number,
	headingId: string,
	headingLabel: string,
): RemixNode {
	return (
		<a
			key={`anchor-${key}`}
			href={`#${headingId}`}
			data-heading-permalink=""
			aria-label={headingLabel}
		>
			<span data-heading-anchor="" aria-hidden="true">
				{renderHeadingAnchorIcon()}
			</span>
		</a>
	)
}
