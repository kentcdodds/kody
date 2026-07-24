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
	 * Browser Sentry config (error capture + error-only replay). Omitted when
	 * SENTRY_DSN is not configured; the DSN is a publishable client key.
	 */
	sentryConfig?: SentryClientConfig | null
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
				<meta name="theme-color" content="#2563eb" />
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
