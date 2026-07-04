/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, type RemixNode } from 'remix/ui'
import { AppRoot, type AppRootProps } from '#client/app-root.tsx'
import {
	buildClientEntryHref,
	buildStylesheetHref,
} from '#app/client-build-id.ts'

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

export function CommunityIndexOgHead(_handle: Handle) {
	return () => (
		<>
			<meta property="og:title" content="Community packages — Kody" />
			<meta
				property="og:description"
				content="Browse community packages shared by Kody users."
			/>
			<meta property="og:type" content="website" />
			<meta name="twitter:card" content="summary" />
		</>
	)
}

type CommunityDetailOgHeadProps = {
	title: string
	description: string
	canonicalUrl: string
	ogImageUrl: string
}

export function CommunityDetailOgHead(
	handle: Handle<CommunityDetailOgHeadProps>,
) {
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
