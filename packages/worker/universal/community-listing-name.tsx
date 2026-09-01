/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */

/**
 * "@scope/name" breaks after the scope slash so a long package name wraps
 * where it reads best instead of overflowing a narrow card or feed row.
 *
 * Its own module (rather than living beside the listings grid) because
 * `community-listings-content.tsx` pulls in `remix/ui/server` for its frame
 * rendering, and this name helper is shared with client-rendered surfaces.
 */
export function renderCommunityListingName(name: string) {
	const slashIndex = name.indexOf('/')
	if (!name.startsWith('@') || slashIndex < 0) return name
	return (
		<>
			{name.slice(0, slashIndex + 1)}
			<wbr />
			{name.slice(slashIndex + 1)}
		</>
	)
}
