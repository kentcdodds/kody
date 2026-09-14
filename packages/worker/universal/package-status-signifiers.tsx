/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { css } from 'remix/ui'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import { colors } from '#universal/styles/tokens.ts'

export type PackageStatusSignifier = {
	kind: 'private' | 'unpublished'
	name: IconName
	title: string
}

export type PackageStatusSignifiersInput = {
	isPrivate: boolean
	isListed: boolean
}

/**
 * Small icon + native tooltip, same grammar as the repositories list
 * package / webhook / job / app signifiers. Private is the lock. Not
 * published is only for unlisted public packages — a private package is
 * already not a community listing, so a second unpublished mark would
 * misread as "never published" when it may have a published commit.
 */
export function listPackageStatusSignifiers(
	input: PackageStatusSignifiersInput,
): Array<PackageStatusSignifier> {
	if (input.isPrivate) {
		return [{ kind: 'private', name: 'lock', title: 'Private' }]
	}
	if (!input.isListed) {
		return [{ kind: 'unpublished', name: 'file', title: 'Not published' }]
	}
	return []
}

export function renderPackageStatusSignifiers(
	input: PackageStatusSignifiersInput,
) {
	const signifiers = listPackageStatusSignifiers(input)
	if (signifiers.length === 0) return null
	return (
		<span
			data-testid="package-visibility-badge"
			data-visibility={input.isPrivate ? 'private' : 'public'}
			mix={css(signifiersCss)}
		>
			{signifiers.map((signifier) => (
				<span
					key={signifier.kind}
					title={signifier.title}
					data-signifier={signifier.kind}
					mix={css(signifierCss)}
				>
					{renderIcon(signifier.name, {
						size: '0.95em',
						title: signifier.title,
					})}
				</span>
			))}
		</span>
	)
}

const signifiersCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	flex: 'none',
	color: colors.textMuted,
}

const signifierCss = {
	display: 'inline-flex',
	alignItems: 'center',
	lineHeight: 0,
}
