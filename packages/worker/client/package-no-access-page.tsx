import { type Handle, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { ErrorAgentPromptButton } from '#client/error-agent-prompt-button.tsx'
import { routes } from '#universal/routes.ts'
import { buildPackageNoAccessErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorImageCss,
	illustratedErrorPageCss,
} from './illustrated-error-page.ts'

export type PackageNoAccessPageProps = {
	username: string
	kodyId: string
	packageName: string
	viewerUsername: string
}

/**
 * Signed-in visitor reached a real package they cannot open. Never reuse the
 * illustrated 404 — a shared private-app handoff must not look unpublished.
 */
export function PackageNoAccessPage(handle: Handle<PackageNoAccessPageProps>) {
	const { username, kodyId, packageName, viewerUsername } = handle.props
	const packageHref = routes.communityPackage.href({ username, kodyId })
	const sharingDocsHref = routes.docDetail.href({ slug: 'package-sharing' })
	const requestMessage = [
		`Hi — please grant me Use on ${packageName}`,
		`(I'm @${viewerUsername}).`,
		`Package page: ${packageHref}`,
	].join(' ')
	const prompt = buildPackageNoAccessErrorAgentPrompt({
		path: packageHref,
		packageName,
		ownerUsername: username,
		viewerUsername,
	})

	return () => (
		<section
			data-testid="package-no-access-page"
			mix={css(illustratedErrorPageCss)}
		>
			<img
				src="/images/kody-404-disappointed.png"
				alt="Kody looking disappointed, holding an Ethernet plug and a USB-C cable that do not match"
				width={1254}
				height={1254}
				mix={css(illustratedErrorImageCss)}
			/>
			<h1 mix={css(illustratedErrorHeadingCss)}>You don't have access</h1>
			<p mix={css(illustratedErrorCopyCss)}>
				<code mix={css(packageNameCss)}>{packageName}</code> is real, but your
				account (@{viewerUsername}) cannot open it. Ask the @{username} owner to
				grant you Use on this package (or invite you to the org).
			</p>
			<nav aria-label="What to try next" mix={css(illustratedErrorActionsCss)}>
				<CopyTextButton
					value={requestMessage}
					idleLabel="Copy access request"
					copiedLabel="Copied"
					variant="pill"
					ariaLabel="Copy an access request message for the package owner"
				/>
				<a href={sharingDocsHref} mix={css(getPillButtonCss())}>
					How sharing works
				</a>
				<a href={routes.home.href()} mix={css(getGhostButtonCss())}>
					Go home
				</a>
			</nav>
			<ErrorAgentPromptButton prompt={prompt} />
		</section>
	)
}

const packageNameCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: '0.95em',
	color: colors.text,
}
