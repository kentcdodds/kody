import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import {
	fetchOnboardingPayload,
	onboardingPath,
	type OnboardingPayload,
} from '#client/routes/onboarding.tsx'
import { pendingVerificationPath } from '#client/routes/pending-verification-path.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
	mq,
} from '#client/styles/tokens.ts'
import {
	getPrimaryButtonCss,
	layoutMaxWidths,
} from '#client/styles/style-primitives.ts'

const workflowSteps = [
	{
		number: '01',
		title: 'Search',
		description:
			'Discover packages, integrations, jobs, secrets, email, storage, and memories.',
	},
	{
		number: '02',
		title: 'Execute',
		description:
			'Run sandboxed code and explicit API calls with secrets kept server-side.',
	},
	{
		number: '03',
		title: 'Build',
		description:
			'Save reusable packages and schedule Worker-native jobs that run while your computer is off.',
	},
] as const

const capabilityHighlights = [
	{
		title: 'Use the assistant you already have',
		description:
			'Connect Kody to Claude, ChatGPT, Cursor, or Codex through MCP. Kody makes zero inference calls, so there is no second agent or model bill.',
	},
	{
		title: 'The fastest way to start',
		description:
			'Install a community package in one click. Every install is a fork you own—open it, change it, schedule it, or publish your version back.',
	},
	{
		title: 'Self-service means ownership',
		description:
			"Bring your own OAuth apps and API keys. Your data is exportable and Kody's source is available to inspect, so your assistant stays portable.",
	},
] as const

function isHomePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/'
}

export async function homeRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const onboarding = await fetchOnboardingPayload(signal)
	if (!onboarding) return {}
	return { onboarding }
}

export function HomeRoute(handle: Handle) {
	let needsOnboarding = false
	let emailVerified = false
	let loggedIn = false
	let onboardingStatus: 'idle' | 'loading' | 'ready' = 'idle'
	const loadLatch = createRouteLoadLatch()

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
		emailVerified = payload?.emailVerified === true
		loggedIn = payload?.loggedIn === true
		onboardingStatus = 'ready'
	}

	async function loadOnboarding(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const payload = await fetchOnboardingPayload(signal)
			if (signal.aborted) return
			applyOnboardingPayload(payload)
			loadLatch.markLoaded(href)
			handle.update()
		} catch {
			if (signal.aborted) return
			needsOnboarding = false
			onboardingStatus = 'ready'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isHomePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (!routeData) return false
		applyOnboardingPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: onboardingStatus === 'loading' || onboardingStatus === 'idle',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			onboardingStatus = 'loading'
			handle.queueTask(loadOnboarding)
		}

		return (
			<section mix={css(pageCss)}>
				{needsOnboarding && emailVerified ? (
					<div
						mix={css({
							width: '100%',
							maxWidth: layoutMaxWidths.content,
							textAlign: 'left',
						})}
					>
						{renderOnboardingBanner()}
					</div>
				) : null}
				<section mix={css(heroCardCss)}>
					<img src="/logo.png" alt="kody logo" mix={css(heroLogoCss)} />
					<div mix={css(heroTextCss)}>
						<h1 mix={css(heroTitleCss)}>
							Your assistant&apos;s{' '}
							<span mix={css({ color: colors.primaryText })}>home</span>
						</h1>
						<p mix={css(heroSubtitleCss)}>
							The memory, keys, code, and automations it keeps, no matter which
							agent you talk to. For builders who&apos;d rather own their
							assistant than rent one.
						</p>
					</div>
					<div mix={css(commandPillRowCss)}>
						{renderCommandPill('remembers')}
						{renderCommandPill('acts')}
					</div>
					<p mix={css(heroTaglineCss)}>
						Kody keeps working while your computer is off.
					</p>
					<div>
						{onboardingStatus === 'ready' &&
						needsOnboarding &&
						loggedIn &&
						!emailVerified ? (
							<a href={pendingVerificationPath} mix={css(heroCtaCss)}>
								Verify your email
							</a>
						) : (
							<a href={onboardingPath} mix={css(heroCtaCss)}>
								Connect your agent
							</a>
						)}
					</div>
					<p mix={css(discoveryHintCss)}>
						Not sure what you&apos;d use it for?{' '}
						<a href={`${onboardingPath}#discovery`} mix={css(discoveryLinkCss)}>
							Ask your agent with the discovery prompt
						</a>
						— no account needed.
					</p>
				</section>

				<section mix={css(sectionCss)}>
					<div mix={css(sectionHeaderCss)}>
						<h2 mix={css(sectionTitleCss)}>How it works</h2>
						<p mix={css(sectionDescriptionCss)}>
							Add Kody to the assistant you already use through MCP. Two
							tools—search and execute—put a vast capability graph behind it.
						</p>
					</div>
					<div mix={css(stepGridCss)}>
						{workflowSteps.map((step) => renderWorkflowStep(step))}
					</div>
				</section>

				<section mix={css(sectionCss)}>
					<div mix={css(sectionHeaderCss)}>
						<h2 mix={css(sectionTitleCss)}>What your assistant keeps</h2>
						<p mix={css(sectionDescriptionCss)}>
							Memory, keys, reusable packages, scheduled jobs, a personal inbox,
							and durable storage—portable across every MCP host.
						</p>
					</div>
					<div mix={css(capabilityGridCss)}>
						{capabilityHighlights.map((capability) =>
							renderCapabilityCard(capability),
						)}
					</div>
				</section>

				<p mix={css(trustLineCss)}>
					Code runs in a sandbox. Secrets stay server-side and never enter
					prompts or your assistant&apos;s context. Every user is fully
					isolated.
				</p>

				<p mix={css(fairSourceLineCss)}>
					Kody is{' '}
					<a
						href="https://github.com/kentcdodds/kody"
						target="_blank"
						rel="noreferrer noopener"
						mix={css(fairSourceLinkCss)}
					>
						Fair Source
					</a>
					, so you can inspect the code.
				</p>
			</section>
		)
	}
}

function renderCommandPill(label: string) {
	return (
		<div mix={css(commandPillCss)}>
			<code>{label}</code>
		</div>
	)
}

function renderWorkflowStep({
	number,
	title,
	description,
}: {
	number: string
	title: string
	description: string
}) {
	return (
		<div mix={css(stepCardCss)}>
			<p mix={css(stepNumberCss)}>{number}</p>
			<h3 mix={css(stepTitleCss)}>{title}</h3>
			<p mix={css(stepDescriptionCss)}>{description}</p>
		</div>
	)
}

function renderCapabilityCard({
	title,
	description,
}: {
	title: string
	description: string
}) {
	return (
		<div mix={css(capabilityCardCss)}>
			<h3 mix={css(capabilityTitleCss)}>{title}</h3>
			<p mix={css(capabilityDescriptionCss)}>{description}</p>
		</div>
	)
}

const pageCss = {
	display: 'grid',
	gap: `calc(${spacing['2xl']} * 1.75)`,
	justifyItems: 'center',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding: spacing.lg,
	textAlign: 'center' as const,
	[mq.mobile]: {
		padding: spacing.sm,
		gap: `calc(${spacing['2xl']} * 1.1)`,
	},
}

const heroCardCss = {
	display: 'grid',
	gap: spacing.lg,
	justifyItems: 'center',
	width: '100%',
	maxWidth: layoutMaxWidths.content,
	padding: `calc(${spacing['2xl']} * 1.5) ${spacing['2xl']}`,
	borderRadius: radius.xl,
	border: `1px solid ${colors.border}`,
	background: `linear-gradient(135deg, ${colors.primarySoftStrong}, ${colors.primarySoftest})`,
	boxShadow: shadows.md,
	[mq.mobile]: {
		padding: spacing.xl,
		gap: spacing.md,
	},
}

const heroLogoCss = {
	width: '240px',
	maxWidth: '100%',
	height: 'auto',
	[mq.mobile]: {
		width: '168px',
	},
}

const heroTextCss = {
	display: 'grid',
	gap: spacing.md,
	maxWidth: '38rem',
}

const heroTitleCss = {
	margin: 0,
	fontSize: 'clamp(3.25rem, 7vw, 5rem)',
	lineHeight: 0.95,
	fontWeight: typography.fontWeight.bold,
	color: colors.text,
}

const heroSubtitleCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.xl,
	lineHeight: 1.6,
	[mq.mobile]: {
		fontSize: typography.fontSize.base,
	},
}

const commandPillRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'center',
	gap: spacing.md,
}

const commandPillCss = {
	padding: `${spacing.xs} ${spacing.md}`,
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.surface,
	color: colors.primaryText,
	fontFamily:
		'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
	fontSize: typography.fontSize.lg,
	boxShadow: shadows.sm,
}

const heroTaglineCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.base,
}

const discoveryHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const discoveryLinkCss = {
	color: colors.primaryText,
}

const heroCtaCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	textDecoration: 'none',
	minWidth: '14rem',
}

const sectionCss = {
	display: 'grid',
	gap: spacing.xl,
	width: '100%',
	maxWidth: layoutMaxWidths.extended,
}

const sectionHeaderCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'center',
	maxWidth: layoutMaxWidths.narrow,
	margin: '0 auto',
}

const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const sectionDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.6,
}

const stepGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: spacing.xl,
	width: '100%',
	[mq.tablet]: {
		gridTemplateColumns: '1fr',
	},
}

const stepCardCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: `${spacing.xl} ${spacing.lg}`,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.sm,
	textAlign: 'left' as const,
	alignContent: 'start',
	minHeight: '12rem',
	[mq.mobile]: {
		padding: spacing.lg,
		minHeight: 'auto',
	},
}

const stepNumberCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const stepTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const stepDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.6,
}

const capabilityGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: spacing.xl,
	width: '100%',
	[mq.tablet]: {
		gridTemplateColumns: '1fr',
	},
}

const capabilityCardCss = {
	display: 'grid',
	gap: spacing.md,
	padding: `${spacing.xl} ${spacing.lg}`,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.sm,
	textAlign: 'left' as const,
	alignContent: 'start',
	minHeight: '13rem',
	[mq.mobile]: {
		padding: spacing.lg,
		minHeight: 'auto',
	},
}

const capabilityTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const capabilityDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.7,
}

const trustLineCss = {
	margin: 0,
	maxWidth: layoutMaxWidths.narrow,
	color: colors.textMuted,
	fontSize: typography.fontSize.base,
	lineHeight: 1.6,
}

const fairSourceLineCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const fairSourceLinkCss = {
	color: colors.primaryText,
}
