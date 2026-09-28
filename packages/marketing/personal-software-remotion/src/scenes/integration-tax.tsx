import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { AppWindow } from '../components/app-window.tsx'
import { Headline, words } from '../components/headline.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { easeIn, easeInOut, mix, progress, settle } from '../motion.ts'
import { colors, fonts } from '../theme.ts'
import { bar, scenes } from '../timing.ts'

type SetupKind = 'sign-in' | 'key' | 'mcp'

type SetupCard = {
	mark: MarkId
	kind: SetupKind
	title: string
	detail: string
	field?: string
	button?: string
	danger?: boolean
	x: number
	y: number
	rotate: number
}

const setupCards: ReadonlyArray<SetupCard> = [
	{
		mark: 'google',
		kind: 'sign-in',
		title: 'Sign in with Google',
		detail: 'Allow access to Gmail and Calendar',
		button: 'Allow',
		x: 34,
		y: 30,
		rotate: -3,
	},
	{
		mark: 'stripe',
		kind: 'key',
		title: 'Paste your Stripe key',
		detail: '.env',
		field: 'STRIPE_SECRET_KEY=sk_live_••••••••',
		x: 350,
		y: 62,
		rotate: 2.5,
	},
	{
		mark: 'github',
		kind: 'mcp',
		title: 'Add the GitHub MCP server',
		detail: 'mcp.json',
		field: '"github": { "command": "npx", … }',
		x: 70,
		y: 228,
		rotate: 1.5,
	},
	{
		mark: 'slack',
		kind: 'sign-in',
		title: 'Create a Slack app',
		detail: 'Add OAuth scopes, then reinstall',
		button: 'Install',
		x: 360,
		y: 258,
		rotate: -2,
	},
	{
		mark: 'linear',
		kind: 'key',
		title: 'Generate a Linear API key',
		detail: 'Settings → Security → API',
		field: 'LINEAR_API_KEY=lin_api_••••••',
		x: 170,
		y: 140,
		rotate: -1,
	},
	{
		mark: 'google',
		kind: 'sign-in',
		title: 'Session expired',
		detail: 'Reconnect Gmail to continue',
		button: 'Reconnect',
		danger: true,
		x: 300,
		y: 296,
		rotate: 3,
	},
]

const windowWidth = 820
const windowHeight = 600

type AppShell = {
	title: string
	address: string
	enterAt: number
	cardTimes: ReadonlyArray<number>
	rest: { x: number; y: number; scale: number }
	stacked?: { x: number; y: number; scale: number; at: number }
}

const cardsEvery = (start: number, step: number) =>
	setupCards.map((_, index) => Math.round(start + index * step))

const shells: ReadonlyArray<AppShell> = [
	{
		title: 'family-hq',
		address: 'localhost:3000',
		enterAt: 4,
		cardTimes: cardsEvery(bar(1, 3), 15),
		rest: { x: 1250, y: 560, scale: 1 },
		stacked: { x: 1040, y: 356, scale: 0.56, at: bar(3, 2) },
	},
	{
		title: 'habit-tracker',
		address: 'localhost:5173',
		enterAt: bar(3, 2) + 8,
		cardTimes: cardsEvery(bar(3, 3), 7.5),
		rest: { x: 1340, y: 580, scale: 0.56 },
	},
	{
		title: 'invoice-bot',
		address: 'localhost:8787',
		enterAt: bar(4) - 1,
		cardTimes: cardsEvery(bar(4) + 6, 5),
		rest: { x: 1655, y: 800, scale: 0.56 },
	},
]

const exitStart = scenes.integrationTax.until - 39

function SetupModal({
	card,
	landedAt,
	frame,
}: {
	card: SetupCard
	landedAt: number
	frame: number
}) {
	if (frame < landedAt - 1) return null
	const drop = settle(frame, landedAt, { damping: 13, stiffness: 170 })
	const scatter = progress(frame, exitStart, exitStart + 24, easeIn)
	const accent = card.danger ? colors.danger : colors.fieldBorder
	return (
		<div
			style={{
				position: 'absolute',
				left: card.x,
				top: card.y,
				width: 430,
				padding: '20px 22px',
				borderRadius: 18,
				background: colors.surfaceRaised,
				border: `1.5px solid ${accent}`,
				boxShadow: '0 24px 50px oklch(0 0 0 / 0.5)',
				opacity: Math.min(1, drop * 1.5) * (1 - scatter),
				transform: `translateY(${mix(-46, 0, drop) + scatter * 140}px) scale(${mix(1.18, 1, drop)}) rotate(${card.rotate * (1 + scatter * 4)}deg)`,
				fontFamily: fonts.body,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
				<MarkWell id={card.mark} size={46} />
				<div style={{ minWidth: 0 }}>
					<div
						style={{
							fontFamily: fonts.display,
							fontWeight: 700,
							fontSize: 23,
							color: card.danger ? colors.danger : colors.text,
							whiteSpace: 'nowrap',
						}}
					>
						{card.title}
					</div>
					<div
						style={{
							fontSize: 17,
							color: colors.textMuted,
							whiteSpace: 'nowrap',
						}}
					>
						{card.detail}
					</div>
				</div>
			</div>
			{card.field ? (
				<div
					style={{
						marginTop: 14,
						padding: '10px 14px',
						borderRadius: 10,
						background: colors.canvas,
						border: `1px solid ${colors.border}`,
						fontFamily: fonts.mono,
						fontSize: 16,
						color: colors.textMuted,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
					}}
				>
					{card.field}
					<span
						style={{
							display: 'inline-block',
							width: 2,
							height: 18,
							marginLeft: 3,
							verticalAlign: 'middle',
							background: colors.text,
							opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0,
						}}
					/>
				</div>
			) : null}
			{card.button ? (
				<div
					style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}
				>
					<div
						style={{
							padding: '8px 20px',
							borderRadius: 999,
							background: card.danger ? colors.danger : colors.text,
							color: colors.canvas,
							fontWeight: 700,
							fontSize: 17,
						}}
					>
						{card.button}
					</div>
				</div>
			) : null}
		</div>
	)
}

function EmptyApp({ steps, frame }: { steps: number; frame: number }) {
	return (
		<div style={{ position: 'absolute', inset: 0, padding: 34 }}>
			<div
				style={{
					fontFamily: fonts.display,
					fontWeight: 700,
					fontSize: 40,
					color: colors.textMuted,
					opacity: 0.55,
				}}
			>
				Hello, Kent
			</div>
			{[0.72, 0.5, 0.62].map((share, index) => (
				<div
					key={index}
					style={{
						marginTop: index === 0 ? 26 : 14,
						width: `${share * 100}%`,
						height: 18,
						borderRadius: 9,
						background: colors.surface,
					}}
				/>
			))}
			<div
				style={{
					position: 'absolute',
					left: 34,
					right: 34,
					bottom: 34,
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					fontSize: 20,
				}}
			>
				<span style={{ color: colors.textMuted }}>0 features shipped</span>
				<span
					style={{
						padding: '8px 18px',
						borderRadius: 999,
						border: `1.5px solid ${steps > 0 ? colors.warning : colors.border}`,
						color: steps > 0 ? colors.warning : colors.textMuted,
						fontWeight: 700,
						transform: `scale(${1 + (steps > 0 ? Math.max(0, 1 - (frame % 15) / 6) * 0.04 : 0)})`,
					}}
				>
					Setup: {steps} {steps === 1 ? 'step' : 'steps'}
				</span>
			</div>
		</div>
	)
}

function Shell({ shell, frame }: { shell: AppShell; frame: number }) {
	if (frame < shell.enterAt - 1) return null
	const enter = settle(frame, shell.enterAt, { damping: 20, stiffness: 110 })
	const stack = shell.stacked
		? progress(frame, shell.stacked.at, shell.stacked.at + 22, easeInOut)
		: 0
	const target = shell.stacked ?? shell.rest
	const x = mix(shell.rest.x, target.x, stack)
	const y = mix(shell.rest.y, target.y, stack)
	const scale = mix(shell.rest.scale, target.scale, stack)
	const landed = shell.cardTimes.filter((at) => frame >= at)
	const lastLanding = landed.at(-1)
	const shake =
		lastLanding == null
			? 0
			: Math.sin((frame - lastLanding) * 2.4) *
				Math.max(0, 1 - (frame - lastLanding) / 9) *
				6
	const leave = progress(frame, exitStart, exitStart + 22, easeIn)
	const collapse = progress(frame, exitStart, exitStart + 22, easeInOut)

	return (
		<AppWindow
			width={windowWidth}
			height={windowHeight}
			title={shell.title}
			address={shell.address}
			accent={landed.length >= 5 ? 'oklch(0.75 0.16 25 / 0.7)' : undefined}
			style={{
				left: mix(x, 960, collapse * 0.3) - windowWidth / 2 + shake,
				top: mix(y, 452, collapse * 0.3) - windowHeight / 2,
				opacity: Math.min(1, enter * 1.4) * (1 - leave),
				transform: `translateY(${mix(70, 0, enter)}px) scale(${scale * mix(0.94, 1, enter) * mix(1, 0.9, leave)})`,
				filter: leave > 0 ? `blur(${leave * 10}px)` : undefined,
			}}
		>
			<EmptyApp steps={landed.length} frame={frame} />
			{setupCards.map((card, index) => (
				<SetupModal
					key={index}
					card={card}
					landedAt={shell.cardTimes[index]!}
					frame={frame}
				/>
			))}
		</AppWindow>
	)
}

const tallies: ReadonlyArray<{ kind: SetupKind; label: string }> = [
	{ kind: 'sign-in', label: 'Sign-ins' },
	{ kind: 'key', label: 'API keys pasted' },
	{ kind: 'mcp', label: 'MCP configs' },
]

function Tallies({ frame }: { frame: number }) {
	const appear = bar(3, 3) + 6
	const leave = progress(frame, exitStart, exitStart + 14, easeIn)
	return (
		<div
			style={{
				position: 'absolute',
				left: 124,
				top: 736,
				display: 'flex',
				gap: 14,
				opacity: 1 - leave,
			}}
		>
			{tallies.map((tally, index) => {
				const count = shells.reduce(
					(sum, shell) =>
						sum +
						setupCards.filter(
							(card, cardIndex) =>
								card.kind === tally.kind &&
								frame >= shell.cardTimes[cardIndex]!,
						).length,
					0,
				)
				const show = settle(frame, appear + index * 4)
				return (
					<div
						key={tally.kind}
						style={{
							padding: '12px 20px',
							borderRadius: 14,
							background: colors.surface,
							border: `1px solid ${colors.border}`,
							fontFamily: fonts.body,
							fontSize: 22,
							color: colors.textMuted,
							opacity: show,
							transform: `translateY(${mix(20, 0, show)}px)`,
							whiteSpace: 'nowrap',
						}}
					>
						{tally.label}{' '}
						<span
							style={{
								fontFamily: fonts.display,
								fontWeight: 800,
								color: colors.warning,
								fontSize: 26,
							}}
						>
							×{count}
						</span>
					</div>
				)
			})}
		</div>
	)
}

export function IntegrationTax() {
	const frame = useCurrentFrame() + scenes.integrationTax.from
	const kickerOpacity =
		progress(frame, 4, 18) * (1 - progress(frame, exitStart, exitStart + 12))

	return (
		<AbsoluteFill>
			{shells.map((shell) => (
				<Shell key={shell.title} shell={shell} frame={frame} />
			))}
			<div
				style={{
					position: 'absolute',
					left: 126,
					top: 300,
					fontFamily: fonts.body,
					fontWeight: 700,
					fontSize: 24,
					letterSpacing: '0.16em',
					textTransform: 'uppercase',
					color: colors.warning,
					opacity: kickerOpacity,
				}}
			>
				The integration tax
			</div>
			<Headline
				frame={frame}
				lines={[words('New personal'), words('app.')]}
				enterAt={10}
				exitAt={bar(3, 1) - 2}
				fontSize={112}
				style={{ left: 120, top: 350 }}
			/>
			<div
				style={{
					position: 'absolute',
					left: 124,
					top: 606,
					width: 640,
					fontFamily: fonts.body,
					fontSize: 32,
					lineHeight: 1.4,
					color: colors.textMuted,
					opacity:
						progress(frame, bar(1, 2), bar(1, 3)) *
						(1 - progress(frame, bar(3, 1), bar(3, 1) + 10)),
				}}
			>
				It just needs your inbox, calendar, GitHub, and Stripe.
			</div>
			<Headline
				frame={frame}
				lines={[
					words('Wire the'),
					words('services…'),
					[{ text: 'again.', color: colors.danger, at: bar(3, 3) }],
				]}
				enterAt={bar(3, 2)}
				exitAt={exitStart}
				fontSize={112}
				style={{ left: 120, top: 350 }}
			/>
			<Tallies frame={frame} />
		</AbsoluteFill>
	)
}
