import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
	mq,
} from '#client/styles/tokens.ts'
import { layoutMaxWidths } from '#client/styles/style-primitives.ts'

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
	let onboardingStatus: 'idle' | 'loading' | 'ready' = 'idle'
	const loadLatch = createRouteLoadLatch()

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
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
			<section
				mix={css({
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: spacing['2xl'],
					textAlign: 'center',
					width: '100%',
					boxSizing: 'border-box',
					padding: spacing.md,
					[mq.mobile]: {
						padding: spacing.sm,
						gap: spacing.xl,
					},
				})}
			>
				{needsOnboarding ? (
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
				<div
					mix={css({
						display: 'grid',
						gap: spacing.lg,
						padding: spacing['2xl'],
						borderRadius: radius.xl,
						border: `1px solid ${colors.border}`,
						background: `linear-gradient(135deg, ${colors.primarySoftStrong}, ${colors.primarySoftest})`,
						boxShadow: shadows.md,
						maxWidth: layoutMaxWidths.narrow,
						width: '100%',
						[mq.mobile]: {
							padding: spacing.lg,
						},
					})}
				>
					<div
						mix={css({
							display: 'grid',
							gap: spacing.lg,
							justifyItems: 'center',
						})}
					>
						<img
							src="/logo.png"
							alt="kody logo"
							mix={css({
								width: '220px',
								maxWidth: '100%',
								height: 'auto',
								[mq.mobile]: {
									width: '160px',
								},
							})}
						/>

						<div mix={css({ display: 'grid', gap: spacing.md })}>
							<h1
								mix={css({
									fontSize: typography.fontSize['2xl'],
									fontWeight: typography.fontWeight.bold,
									margin: 0,
									color: colors.text,
								})}
							>
								Meet <span mix={css({ color: colors.primaryText })}>kody</span>
							</h1>
							<p
								mix={css({
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.lg,
									lineHeight: 1.6,
									[mq.mobile]: {
										fontSize: typography.fontSize.base,
									},
								})}
							>
								Your personal assistant, built to work from any AI agent host
								that supports MCP.
							</p>
						</div>
					</div>
				</div>

				<div
					mix={css({
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
						gap: spacing.lg,
						maxWidth: layoutMaxWidths.content,
						width: '100%',
						[mq.mobile]: {
							gridTemplateColumns: '1fr',
							gap: spacing.md,
						},
					})}
				>
					{renderFeatureCard({
						title: 'MCP Powered',
						description:
							'Designed to keep the public MCP surface small while exposing a vast graph of capabilities behind the scenes.',
						icon: '🔌',
					})}
					{renderFeatureCard({
						title: 'Highly Portable',
						description:
							'Built to interoperate across MCP-capable hosts, keeping the focus on the assistant rather than host-specific apps.',
						icon: '🚀',
					})}
					{renderFeatureCard({
						title: 'Personalized',
						description:
							'Optimized for personal workflows and fast iteration, not generic multi-tenant administration.',
						icon: '🧠',
					})}
				</div>
			</section>
		)
	}
}

function renderFeatureCard({
	title,
	description,
	icon,
}: {
	title: string
	description: string
	icon: string
}) {
	return (
		<div
			mix={css({
				display: 'grid',
				gap: spacing.sm,
				padding: spacing.lg,
				borderRadius: radius.lg,
				border: `1px solid ${colors.border}`,
				background: colors.surface,
				boxShadow: shadows.sm,
				textAlign: 'left',
				transition: 'transform 0.2s ease-in-out',
				'&:hover': {
					transform: 'translateY(-2px)',
					boxShadow: shadows.md,
				},
				[mq.mobile]: {
					padding: spacing.md,
				},
			})}
		>
			<div mix={css({ fontSize: '2rem', marginBottom: spacing.xs })}>
				{icon}
			</div>
			<h3
				mix={css({
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					margin: 0,
					color: colors.text,
					[mq.mobile]: {
						fontSize: typography.fontSize.base,
					},
				})}
			>
				{title}
			</h3>
			<p
				mix={css({
					margin: 0,
					color: colors.textMuted,
					lineHeight: 1.5,
					[mq.mobile]: {
						fontSize: typography.fontSize.sm,
					},
				})}
			>
				{description}
			</p>
		</div>
	)
}
