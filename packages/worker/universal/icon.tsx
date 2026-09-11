/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, type RemixNode } from 'remix/ui'
import { iconGlyphs, type IconName } from './icon-glyphs.tsx'

export type { IconName } from './icon-glyphs.tsx'

/**
 * Iconic draws in a 24×24 viewBox with ~4.75 units of padding so the 1.5px
 * stroke never clips. That reads small next to type. Crop to the glyph the
 * same way `provider-icons` crops padded brand marks.
 */
export const iconicGlyphViewBox = '3.75 3.75 16.5 16.5'

const defaultIconSize = '1em'

export type IconProps = {
	name: IconName
	size?: string
	/**
	 * Accessible name. Omit for decorative icons (they are `aria-hidden`).
	 */
	title?: string
}

export function renderIcon(
	name: IconName,
	options: { size?: string; title?: string } = {},
): RemixNode {
	const size = options.size ?? defaultIconSize
	const labelled = Boolean(options.title)
	return (
		<svg
			data-icon={name}
			viewBox={iconicGlyphViewBox}
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden={labelled ? undefined : 'true'}
			role={labelled ? 'img' : undefined}
			aria-label={options.title}
			focusable={false}
		>
			{iconGlyphs[name]()}
		</svg>
	)
}

export function Icon(handle: Handle<IconProps>) {
	return () => renderIcon(handle.props.name, handle.props)
}
