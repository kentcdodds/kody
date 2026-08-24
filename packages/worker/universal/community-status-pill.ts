/**
 * Shared box for Trusted / Featured / Install / Installed / Fork outdated.
 * Spans inherit a taller line-height than reset buttons, so adjacent pills
 * mismatch unless every variant uses the same flex box.
 */
export const communityStatusPillBoxCss = {
	display: 'inline-flex' as const,
	alignItems: 'center' as const,
	justifyContent: 'center' as const,
	boxSizing: 'border-box' as const,
	flex: 'none' as const,
	margin: 0,
	fontFamily: 'inherit',
	fontSize: '0.78rem',
	fontWeight: 650,
	lineHeight: 1.2,
	borderRadius: '999px',
	padding: '0.15rem 0.6rem',
	border: '1px solid transparent',
	whiteSpace: 'nowrap' as const,
}
