import { type Handle, css } from 'remix/ui'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
	mq,
} from '#client/styles/tokens.ts'

export function HomeRoute(_handle: Handle) {
	return () => (
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
			<div
				mix={css({
					display: 'grid',
					gap: spacing.lg,
					padding: spacing['2xl'],
					borderRadius: radius.xl,
					border: `1px solid ${colors.border}`,
					background: `linear-gradient(135deg, ${colors.primarySoftStrong}, ${colors.primarySoftest})`,
					boxShadow: shadows.md,
					maxWidth: '48rem',
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
							Your personal assistant, built to work from any AI agent host that
							supports MCP.
						</p>
					</div>
				</div>
			</div>

			<div
				mix={css({
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
					gap: spacing.lg,
					maxWidth: '64rem',
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
