import { type Handle, css } from 'remix/ui'
import { getLogoWellCss } from '#universal/styles/style-primitives.ts'

/**
 * Inline brand marks for the social login providers and integration provider
 * suggestions. Inlined as SVG (no external assets) so they server-render with
 * the buttons and inherit sizing and color from the surrounding text.
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
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.375.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .793-.42.84l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.45.326s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.696.514.928.653.928 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.973.047-1.447-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
		</svg>
	)
}

function renderDiscordIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5865F2"
		>
			<path d="M22.991 2.01A26.189 26.189 0 0 0 16.458 0a17.948 17.948 0 0 0-.837 1.701A24.329 24.329 0 0 0 8.371 1.701 18.025 18.025 0 0 0 7.534 0 26.374 26.374 0 0 0 .996 2.015C-3.138 8.132-4.259 14.097-3.699 19.978A26.334 26.334 0 0 0 4.314 24 19.352 19.352 0 0 0 6.03 21.233a17.041 17.041 0 0 1-2.702-1.29c.227-.164.448-.334.663-.498a18.822 18.822 0 0 0 16.02 0c.217.177.438.346.663.498a17.106 17.106 0 0 1-2.707 1.293 19.178 19.178 0 0 0 1.716 2.765A26.214 26.214 0 0 0 27.699 19.98C28.356 13.161 26.575 7.25 22.991 2.01ZM6.74 16.361C5.178 16.361 3.888 14.944 3.888 13.2s1.245-3.173 2.847-3.173S9.616 11.457 9.589 13.2 8.331 16.361 6.74 16.361Zm10.521 0C15.696 16.361 14.411 14.944 14.411 13.2s1.245-3.173 2.849-3.173S20.134 11.457 20.107 13.2 18.852 16.361 17.26 16.361Z" />
		</svg>
	)
}

const knownProviderIconIds = [
	'discord',
	'github',
	'google',
	'notion',
	'slack',
	'spotify',
	'x',
] as const

export type ProviderIconId = (typeof knownProviderIconIds)[number]

const providerIconRenderers: Record<
	ProviderIconId,
	(size: string) => JSX.Element
> = {
	github: renderGitHubIcon,
	google: renderGoogleIcon,
	x: renderXIcon,
	slack: renderSlackIcon,
	spotify: renderSpotifyIcon,
	notion: renderNotionIcon,
	discord: renderDiscordIcon,
}

const providerIconHosts: Record<string, ProviderIconId> = {
	'accounts.google.com': 'google',
	'accounts.spotify.com': 'spotify',
	'api.github.com': 'github',
	'api.notion.com': 'notion',
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
