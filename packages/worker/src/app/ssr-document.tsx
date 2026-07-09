/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, type RemixNode } from 'remix/ui'
import { AppRoot, type AppRootProps } from '#client/app-root.tsx'
import {
	buildClientEntryHref,
	buildStylesheetHref,
} from '#app/client-build-id.ts'
import { publicOgPages, type PublicOgPageId } from '#worker/og/pages.ts'

export const CLIENT_ENTRY_HREF = '/client-entry.js'
export const STYLESHEET_HREF = '/styles.css'

export type SsrDocumentProps = AppRootProps & {
	title?: string
	extraHead?: RemixNode
	clientEntryHref?: string
	stylesheetHref?: string
}

export function SsrDocument(handle: Handle<SsrDocumentProps>) {
	const clientEntryHref =
		handle.props.clientEntryHref ?? buildClientEntryHref('dev')
	const stylesheetHref =
		handle.props.stylesheetHref ?? buildStylesheetHref('dev')

	return () => (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<link rel="icon" href="/favicon.ico" sizes="any" />
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href="/favicon-32x32.png"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="16x16"
					href="/favicon-16x16.png"
				/>
				<link
					rel="apple-touch-icon"
					sizes="180x180"
					href="/apple-touch-icon.png"
				/>
				<link rel="manifest" href="/site.webmanifest" />
				<meta name="theme-color" content="#2563eb" />
				<title>{handle.props.title ?? 'kody'}</title>
				{handle.props.extraHead ?? null}
				<link rel="modulepreload" href={clientEntryHref} />
				<link rel="stylesheet" href={stylesheetHref} />
			</head>
			<body>
				<div id="root">
					<AppRoot
						url={handle.props.url}
						session={handle.props.session}
						loaderData={handle.props.loaderData}
						notFound={handle.props.notFound}
					/>
				</div>
				<script type="module" src={clientEntryHref}></script>
			</body>
		</html>
	)
}

type OgHeadProps = {
	title: string
	description: string
	canonicalUrl: string
	ogImageUrl: string
}

/**
 * Open Graph / Twitter card tags for public pages. `ogImageUrl` should point
 * at a Satori-generated 1200×630 PNG (`/og/:page.png` for static pages,
 * `/community/:listingId/og.png` for community packages).
 */
export function OgHead(handle: Handle<OgHeadProps>) {
	return () => (
		<>
			<meta property="og:title" content={handle.props.title} />
			<meta property="og:description" content={handle.props.description} />
			<meta property="og:image" content={handle.props.ogImageUrl} />
			<meta property="og:type" content="website" />
			<meta property="og:url" content={handle.props.canonicalUrl} />
			<meta name="twitter:card" content="summary_large_image" />
			<meta name="twitter:title" content={handle.props.title} />
			<meta name="twitter:description" content={handle.props.description} />
			<meta name="twitter:image" content={handle.props.ogImageUrl} />
			<link rel="canonical" href={handle.props.canonicalUrl} />
		</>
	)
}

/**
 * Build the `extraHead` node for a registered public page (see
 * `#worker/og/pages.ts`). Kept here so plain `.ts` handlers can attach OG
 * tags without needing JSX.
 */
export function createPageOgHeadNode(input: {
	origin: string
	pageId: PublicOgPageId
}): RemixNode {
	const page = publicOgPages[input.pageId]
	return (
		<OgHead
			title={page.ogTitle}
			description={page.ogDescription}
			canonicalUrl={`${input.origin}${page.path}`}
			ogImageUrl={`${input.origin}/og/${input.pageId}.png`}
		/>
	) as RemixNode
}
