/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle } from 'remix/ui'
import { AppRoot, type AppRootProps } from '#client/app-root.tsx'
import {
	buildClientEntryHref,
	buildStylesheetHref,
} from '#app/client-build-id.ts'
import {
	DOCUMENT_HEAD_ATTR,
	type ResolvedDocumentHead,
} from '#app/document-head.ts'
import {
	SENTRY_CONFIG_META_NAME,
	type SentryClientConfig,
} from '#client/sentry-config.ts'

export const CLIENT_ENTRY_HREF = '/client-entry.js'
export const STYLESHEET_HREF = '/styles.css'

export type SsrDocumentProps = AppRootProps & {
	title?: string
	documentHead?: ResolvedDocumentHead
	clientEntryHref?: string
	stylesheetHref?: string
	/**
	 * Hashed chunk hrefs the entry (and current route's lazy area) will
	 * import, from the build-time client manifest. Preloading them avoids a
	 * request waterfall before hydration. Empty in dev.
	 */
	modulePreloadHrefs?: Array<string>
	/**
	 * Full stylesheet text to inline into a `<style>` tag (removes the
	 * render-blocking stylesheet request). When absent, the stylesheet
	 * `<link>` is rendered instead.
	 */
	inlineStylesheet?: string | null
	/**
	 * Browser Sentry config (error capture + error-only replay). Omitted when
	 * SENTRY_DSN is not configured; the DSN is a publishable client key.
	 */
	sentryConfig?: SentryClientConfig | null
	/**
	 * Fathom Analytics site id (public). Omitted when FATHOM_SITE_ID is not
	 * configured (local dev, preview, tests) so no tracker script is embedded.
	 */
	fathomSiteId?: string | null
}

function managedHeadAttr(value: string) {
	return { [DOCUMENT_HEAD_ATTR]: value }
}

/**
 * Managed OG / Twitter / canonical tags. Marked with `data-kody-head` so the
 * client router can upsert or remove them on SPA navigations.
 */
export function ManagedDocumentHead(
	handle: Handle<{ head: ResolvedDocumentHead }>,
) {
	return () => {
		const { head } = handle.props
		return (
			<>
				{head.description ? (
					<meta
						name="description"
						content={head.description}
						{...managedHeadAttr('description')}
					/>
				) : null}
				{head.og ? (
					<>
						<meta
							property="og:title"
							content={head.og.title}
							{...managedHeadAttr('og:title')}
						/>
						<meta
							property="og:description"
							content={head.og.description}
							{...managedHeadAttr('og:description')}
						/>
						<meta
							property="og:image"
							content={head.og.imageUrl}
							{...managedHeadAttr('og:image')}
						/>
						<meta
							property="og:type"
							content="website"
							{...managedHeadAttr('og:type')}
						/>
						{head.canonicalUrl ? (
							<meta
								property="og:url"
								content={head.canonicalUrl}
								{...managedHeadAttr('og:url')}
							/>
						) : null}
						<meta
							name="twitter:card"
							content="summary_large_image"
							{...managedHeadAttr('twitter:card')}
						/>
						<meta
							name="twitter:title"
							content={head.og.title}
							{...managedHeadAttr('twitter:title')}
						/>
						<meta
							name="twitter:description"
							content={head.og.description}
							{...managedHeadAttr('twitter:description')}
						/>
						<meta
							name="twitter:image"
							content={head.og.imageUrl}
							{...managedHeadAttr('twitter:image')}
						/>
					</>
				) : null}
				{head.canonicalUrl ? (
					<link
						rel="canonical"
						href={head.canonicalUrl}
						{...managedHeadAttr('canonical')}
					/>
				) : null}
				{(head.links ?? []).map((link, index) => (
					<link
						key={`link:${index}`}
						rel={link.rel}
						href={link.href}
						type={link.type}
						title={link.title}
						{...managedHeadAttr(`link:${index}`)}
					/>
				))}
			</>
		)
	}
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
				<meta
					name="theme-color"
					content="#e6e8ea"
					media="(prefers-color-scheme: light)"
				/>
				<meta
					name="theme-color"
					content="#111417"
					media="(prefers-color-scheme: dark)"
				/>
				{/* Blocking on purpose: applies the stored theme and the `js`
				    class before first paint (no theme flash, enhance-only
				    motion). CSP disallows inline scripts, hence the file. */}
				<script src="/theme-init.js"></script>
				{/* Fonts are self-hosted (CSP allows only 'self' for styles and
				    fonts); preload the latin faces used on every page. */}
				<link
					rel="preload"
					as="font"
					type="font/woff2"
					href="/fonts/bricolage-grotesque-latin.woff2"
					crossOrigin="anonymous"
				/>
				<link
					rel="preload"
					as="font"
					type="font/woff2"
					href="/fonts/wix-madefor-text-latin.woff2"
					crossOrigin="anonymous"
				/>
				<title>
					{handle.props.documentHead?.title ?? handle.props.title ?? 'kody'}
				</title>
				{handle.props.documentHead ? (
					<ManagedDocumentHead head={handle.props.documentHead} />
				) : null}
				{handle.props.sentryConfig ? (
					<meta
						name={SENTRY_CONFIG_META_NAME}
						content={JSON.stringify(handle.props.sentryConfig)}
					/>
				) : null}
				{handle.props.fathomSiteId ? (
					<>
						{/* The deferred tracker script loads late; warming the
						    connection up front hides the TLS handshake. */}
						<link rel="preconnect" href="https://cdn.usefathom.com" />
						{/* data-spa="auto" makes Fathom track client-side (pushState)
						    navigations, not just full document loads. */}
						<script
							src="https://cdn.usefathom.com/script.js"
							data-site={handle.props.fathomSiteId}
							data-spa="auto"
							defer
						></script>
					</>
				) : null}
				<link rel="modulepreload" href={clientEntryHref} />
				{(handle.props.modulePreloadHrefs ?? []).map((href) => (
					<link key={href} rel="modulepreload" href={href} />
				))}
				{handle.props.inlineStylesheet ? (
					<style>{handle.props.inlineStylesheet}</style>
				) : (
					<link rel="stylesheet" href={stylesheetHref} />
				)}
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
