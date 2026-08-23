import { type Handle, css } from 'remix/ui'
import { getLogoWellCss } from '#universal/styles/style-primitives.ts'

/**
 * Inline official brand marks for social login providers, integration
 * suggestions, and onboarding Step 2 MCP chooser cards. Inlined as SVG (no
 * external assets) so they server-render with the buttons. Paths are the
 * vendor mark (Simple Icons / official brand kit) — do not invent lookalikes.
 */
const defaultIconSize = '1.25em'

function renderGitHubIcon(size: string) {
	return (
		<svg
			viewBox="0 0 16 16"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	)
}

function renderGoogleIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<path
				fill="#4285F4"
				d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
			/>
			<path
				fill="#FBBC05"
				d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
			/>
		</svg>
	)
}

function renderXIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
		</svg>
	)
}

function renderSlackIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<path
				fill="#E01E5A"
				d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522z"
			/>
			<path
				fill="#36C5F0"
				d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521z"
			/>
			<path
				fill="#2EB67D"
				d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522zm-1.27 0a2.528 2.528 0 0 1-2.522 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.164 0a2.528 2.528 0 0 1 2.522 2.522z"
			/>
			<path
				fill="#ECB22E"
				d="M15.165 18.956a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522zm0-1.27a2.527 2.527 0 0 1-2.52-2.521 2.527 2.527 0 0 1 2.52-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.521z"
			/>
		</svg>
	)
}

function renderSpotifyIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#1DB954"
		>
			<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
		</svg>
	)
}

function renderNotionIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
		</svg>
	)
}

function renderLinearIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5E6AD2"
		>
			<path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
		</svg>
	)
}

function renderDiscordIcon(size: string) {
	// Clyde sits with more padding than the other 24×24 marks, so crop the
	// viewBox so it optically matches GitHub/Google/X at the same size.
	return (
		<svg
			viewBox="0 2.25 24 19.5"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5865F2"
		>
			<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
		</svg>
	)
}

function renderAsanaIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<circle cx="12" cy="6.4" r="3.15" fill="#F06A6A" />
			<circle cx="7.15" cy="16.35" r="3.15" fill="#F06A6A" />
			<circle cx="16.85" cy="16.35" r="3.15" fill="#F06A6A" />
		</svg>
	)
}

function renderSentryIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#362D59"
		>
			<path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
		</svg>
	)
}

function renderCanvaIcon(size: string) {
	return (
		<svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<circle cx="32" cy="32" r="32" fill="#00C4CC" />
			<path
				fill="#fff"
				d="M45.6 43.1c-1.7 2.3-3.9 4.7-6.8 6.5-2.8 1.8-6 3.2-9.8 3.2-3.5 0-6.4-1.8-8-3.3-2.4-2.3-3.7-5.6-4.1-8.7-1.2-9.6 4.7-22.3 13.8-27.8 2.1-1.3 4.4-1.9 6.6-1.9 4.4 0 7.7 3.1 8.1 6.9.4 3.4-.9 6.3-4.7 8.2-1.9 1-2.9.9-3.2.5-.2-.3-.1-.8.3-1.1 3.5-2.9 3.6-5.3 3.2-8.7-.3-2.2-1.7-3.6-3.3-3.6-6.9 0-16.9 15.5-15.5 26.7.5 4.4 3.2 9.5 8.8 9.5 1.8 0 3.8-.5 5.5-1.4 3.9-2 5.6-3.4 7.9-6.6.3-.4.6-.9.9-1.3.2-.4.6-.5.9-.5.3 0 .7.3.7.8 0 .3-.1.9-.5 1.4-.4.8-.7 1.4-1.1 1.8z"
			/>
		</svg>
	)
}

function renderAtlassianIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#1868DB"
		>
			<path d="M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z" />
		</svg>
	)
}

function renderStripeIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#635BFF"
		>
			<path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
		</svg>
	)
}

const knownProviderIconIds = [
	'asana',
	'atlassian',
	'canva',
	'discord',
	'github',
	'google',
	'linear',
	'notion',
	'sentry',
	'slack',
	'spotify',
	'stripe',
	'x',
] as const

export type ProviderIconId = (typeof knownProviderIconIds)[number]

const providerIconRenderers: Record<
	ProviderIconId,
	(size: string) => JSX.Element
> = {
	asana: renderAsanaIcon,
	atlassian: renderAtlassianIcon,
	canva: renderCanvaIcon,
	github: renderGitHubIcon,
	google: renderGoogleIcon,
	linear: renderLinearIcon,
	x: renderXIcon,
	sentry: renderSentryIcon,
	slack: renderSlackIcon,
	spotify: renderSpotifyIcon,
	stripe: renderStripeIcon,
	notion: renderNotionIcon,
	discord: renderDiscordIcon,
}

const providerIconHosts: Record<string, ProviderIconId> = {
	'accounts.google.com': 'google',
	'accounts.spotify.com': 'spotify',
	'api.github.com': 'github',
	'api.linear.app': 'linear',
	'api.notion.com': 'notion',
	'linear.app': 'linear',
	'mcp.asana.com': 'asana',
	'mcp.atlassian.com': 'atlassian',
	'mcp.canva.com': 'canva',
	'mcp.linear.app': 'linear',
	'mcp.notion.com': 'notion',
	'mcp.sentry.dev': 'sentry',
	'mcp.slack.com': 'slack',
	'mcp.stripe.com': 'stripe',
	'app.asana.com': 'asana',
	'asana.com': 'asana',
	'atlassian.com': 'atlassian',
	'auth.atlassian.com': 'atlassian',
	'canva.com': 'canva',
	'sentry.io': 'sentry',
	'api.stripe.com': 'stripe',
	'stripe.com': 'stripe',
	'api.spotify.com': 'spotify',
	'discord.com': 'discord',
	'discordapp.com': 'discord',
	'github.com': 'github',
	'googleapis.com': 'google',
	'notion.so': 'notion',
	'oauth2.googleapis.com': 'google',
	'slack.com': 'slack',
	'spotify.com': 'spotify',
	'twitter.com': 'x',
	'x.com': 'x',
}

function isProviderIconId(value: string): value is ProviderIconId {
	return (knownProviderIconIds as ReadonlyArray<string>).includes(value)
}

/**
 * Maps a connect-page provider key (`google-youtube-brand`) or authorize
 * host (`accounts.google.com`) onto an inline brand mark. `x` only matches
 * exact / `x-…` / twitter names so short keys like `example` stay unmatched.
 */
export function resolveProviderIconId(input: {
	providerKey?: string | null
	host?: string | null
}): ProviderIconId | null {
	const key = input.providerKey?.trim().toLowerCase() ?? ''
	if (isProviderIconId(key)) return key
	if (key === 'twitter' || key.startsWith('x-')) return 'x'
	if (key) {
		for (const id of knownProviderIconIds) {
			if (id === 'x') continue
			if (key.startsWith(`${id}-`) || key.endsWith(`-${id}`)) return id
		}
	}
	const host = input.host?.trim().toLowerCase() ?? ''
	if (!host) return null
	if (providerIconHosts[host]) return providerIconHosts[host]
	for (const [known, id] of Object.entries(providerIconHosts)) {
		if (host === known || host.endsWith(`.${known}`)) return id
	}
	return null
}

export function ProviderIcon(
	handle: Handle<{
		providerId: string
		/** Icon box size; inline-with-text usages should pass `1em`. */
		size?: string
	}>,
) {
	return () =>
		providerIconRenderers[handle.props.providerId as ProviderIconId]?.(
			handle.props.size ?? defaultIconSize,
		) ?? null
}

/**
 * Provider identity for connect / integration headers: uploaded logo, known
 * brand SVG, or a letter fallback. Always sits on the white logo well so
 * dark marks stay readable in dark mode.
 */
export function ProviderMark(
	handle: Handle<{
		providerKey: string
		label: string
		logoPath?: string | null
		host?: string | null
		size?: string
	}>,
) {
	return () => {
		const { providerKey, label, logoPath, host } = handle.props
		const wellSize = handle.props.size ?? '3rem'
		const iconId = resolveProviderIconId({ providerKey, host })
		const letter = label.trim().charAt(0).toUpperCase() || '?'
		const iconSize =
			wellSize === '3rem' ? '1.65rem' : `calc(${wellSize} * 0.62)`
		return (
			<span
				aria-hidden="true"
				data-testid="provider-mark"
				mix={css({
					...getLogoWellCss({
						size: wellSize,
						radius: '0',
					}),
					fontWeight: 700,
					fontSize: `calc(${wellSize} * 0.42)`,
					lineHeight: 1,
				})}
			>
				{logoPath ? (
					<img
						src={logoPath}
						alt=""
						width={40}
						height={40}
						mix={css({
							display: 'block',
							width: '70%',
							height: '70%',
							objectFit: 'contain' as const,
						})}
					/>
				) : iconId ? (
					<ProviderIcon providerId={iconId} size={iconSize} />
				) : (
					letter
				)}
			</span>
		)
	}
}
