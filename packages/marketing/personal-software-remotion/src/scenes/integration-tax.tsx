import { AbsoluteFill, Img, useCurrentFrame } from 'remotion'
import wearyFace from '../art/noto-emoji-weary-face.svg'
import { AppWindow } from '../components/app-window.tsx'
import { Headline, words } from '../components/headline.tsx'
import { MarkWell, type MarkId } from '../components/mark.tsx'
import { easeIn, easeInOut, mix, progress, pulse, settle } from '../motion.ts'
import { colors, fonts } from '../theme.ts'
import { scenes } from '../timing.ts'

/**
 * Beat 1 cue sheet. One full cycle (wire, build, deploy) at a readable pace,
 * then the same wiring again, faster each time, until "Ugh" lands just
 * before the drop.
 */
const cue = {
	firstApp: 4,
	needApp: 8,
	checklist: 32,
	wire: { start: 44, cards: 48, every: 12 },
	build: { start: 108, end: 128 },
	deploy: { start: 128, end: 142 },
	needAnother: 150,
	again: 180,
	andAgain: [210, 226, 240],
	ugh: 256,
	exit: scenes.integrationTax.until - 37,
} as const

type SetupCard = {
	mark: MarkId
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
		title: 'Sign in with Google',
		detail: 'Allow access to Gmail and Calendar',
		button: 'Allow',
		x: 34,
		y: 30,
		rotate: -3,
	},
	{
		mark: 'stripe',
		title: 'Paste your Stripe key',
		detail: '.env',
		field: 'STRIPE_SECRET_KEY=sk_live_••••••••',
		x: 350,
		y: 62,
		rotate: 2.5,
	},
	{
		mark: 'github',
		title: 'Add the GitHub MCP server',
		detail: 'mcp.json',
		field: '"github": { "command": "npx", … }',
		x: 70,
		y: 228,
		rotate: 1.5,
	},
	{
		mark: 'slack',
		title: 'Create a Slack app',
		detail: 'Add OAuth scopes, then reinstall',
		button: 'Install',
		x: 360,
		y: 258,
		rotate: -2,
	},
	{
		mark: 'linear',
		title: 'Generate a Linear API key',
		detail: 'Settings → Security → API',
		field: 'LINEAR_API_KEY=lin_api_••••••',
		x: 170,
		y: 140,
		rotate: -1,
	},
	{
		mark: 'google',
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
const slotScale = 0.44

function slot(index: number) {
	return { x: 1080 + index * 150, y: 250 + index * 150, scale: slotScale }
}

type AppShell = {
	title: string
	address: string
	enterAt: number
	cardTimes: ReadonlyArray<number>
	rest: { x: number; y: number; scale: number }
	stacked?: { x: number; y: number; scale: number; at: number }
	shipped?: { address: string }
	slump: number
}

const cardsEvery = (start: number, step: number, count = 5) =>
	setupCards.slice(0, count).map((_, index) => Math.round(start + index * step))

const shells: ReadonlyArray<AppShell> = [
	{
		title: 'family-hq',
		address: 'localhost:3000',
		enterAt: cue.firstApp,
		cardTimes: cardsEvery(cue.wire.cards, cue.wire.every),
		rest: { x: 1250, y: 560, scale: 1 },
		stacked: { ...slot(0), at: cue.needAnother },
		shipped: { address: 'family-hq.app' },
		slump: -2,
	},
	{
		title: 'habit-tracker',
		address: 'localhost:5173',
		enterAt: cue.needAnother + 6,
		cardTimes: cardsEvery(cue.again + 2, 5),
		rest: { x: 1310, y: 630, scale: 0.8 },
		stacked: { ...slot(1), at: cue.andAgain[0] - 4 },
		slump: 2.5,
	},
	{
		title: 'invoice-bot',
		address: 'localhost:8787',
		enterAt: cue.andAgain[0] - 3,
		cardTimes: cardsEvery(cue.andAgain[0] + 1, 3),
		rest: slot(2),
		slump: -1.5,
	},
	{
		title: 'meal-planner',
		address: 'localhost:4321',
		enterAt: cue.andAgain[1] - 2,
		cardTimes: cardsEvery(cue.andAgain[1] + 1, 2.5),
		rest: slot(3),
		slump: 3,
	},
	{
		title: 'podcast-notes',
		address: 'localhost:8000',
		enterAt: cue.andAgain[2] - 2,
		cardTimes: cardsEvery(cue.andAgain[2] + 1, 2, 6),
		rest: slot(4),
		slump: -2.5,
	},
]

function SetupModal({
	card,
	landedAt,
	clearAt,
	frame,
}: {
	card: SetupCard
	landedAt: number
	clearAt?: number
	frame: number
}) {
	if (frame < landedAt - 1) return null
	const drop = settle(frame, landedAt, { damping: 13, stiffness: 170 })
	const scatter = progress(frame, cue.exit, cue.exit + 24, easeIn)
	const cleared =
		clearAt == null ? 0 : progress(frame, clearAt, clearAt + 10, easeIn)
	if (cleared >= 1) return null
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
				opacity: Math.min(1, drop * 1.5) * (1 - scatter) * (1 - cleared),
				transform: `translateY(${mix(-46, 0, drop) + scatter * 140}px) scale(${mix(1.18, 1, drop) * mix(1, 0.6, cleared)}) rotate(${card.rotate * (1 + scatter * 4)}deg)`,
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

/** App body: a skeleton that fills in once built, with a status pill. */
function AppBody({
	steps,
	built,
	live,
	frame,
}: {
	steps: number
	built: number
	live: boolean
	frame: number
}) {
	const building = built > 0 && built < 1
	const rows = [
		{ share: 0.72, color: colors.primary },
		{ share: 0.5, color: 'oklch(0.72 0.17 255)' },
		{ share: 0.62, color: 'oklch(0.8 0.18 345)' },
	]
	return (
		<div style={{ position: 'absolute', inset: 0, padding: 34 }}>
			{building ? (
				<div
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						height: 5,
						width: `${built * 100}%`,
						background: colors.primary,
						boxShadow: `0 0 12px ${colors.primary}`,
					}}
				/>
			) : null}
			<div
				style={{
					fontFamily: fonts.display,
					fontWeight: 700,
					fontSize: 40,
					color: built > 0.5 ? colors.text : colors.textMuted,
					opacity: mix(0.55, 1, built),
				}}
			>
				Hello, Kent
			</div>
			{rows.map((row, index) => (
				<div
					key={index}
					style={{
						position: 'relative',
						marginTop: index === 0 ? 26 : 14,
						width: `${row.share * 100}%`,
						height: 18,
						borderRadius: 9,
						background: colors.surface,
						overflow: 'hidden',
					}}
				>
					<div
						style={{
							position: 'absolute',
							inset: 0,
							width: `${progress(built, index * 0.2, 0.6 + index * 0.2) * 100}%`,
							background: row.color,
							opacity: 0.8,
						}}
					/>
				</div>
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
				<span style={{ color: colors.textMuted }}>
					{built >= 1 ? '3 features shipped' : '0 features shipped'}
				</span>
				{live ? (
					<span
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							padding: '8px 18px',
							borderRadius: 999,
							border: `1.5px solid ${colors.primary}`,
							color: colors.primary,
							fontWeight: 700,
						}}
					>
						<span
							style={{
								width: 10,
								height: 10,
								borderRadius: '50%',
								background: colors.primary,
							}}
						/>
						Live
					</span>
				) : built > 0 ? null : (
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
				)}
			</div>
		</div>
	)
}

function Shell({ shell, frame }: { shell: AppShell; frame: number }) {
	if (frame < shell.enterAt - 1) return null
	const enter = settle(frame, shell.enterAt, { damping: 20, stiffness: 120 })
	const stack = shell.stacked
		? progress(frame, shell.stacked.at, shell.stacked.at + 18, easeInOut)
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
	const built = shell.shipped
		? progress(frame, cue.build.start, cue.build.end, easeInOut)
		: 0
	const live = shell.shipped != null && frame >= cue.deploy.start + 6
	const deployFlash = shell.shipped ? pulse(frame, cue.deploy.start + 6, 20) : 0
	const slump = settle(frame, cue.ugh, { damping: 11, stiffness: 140 })
	const leave = progress(frame, cue.exit, cue.exit + 22, easeIn)
	const collapse = progress(frame, cue.exit, cue.exit + 22, easeInOut)

	return (
		<AppWindow
			width={windowWidth}
			height={windowHeight}
			title={shell.title}
			address={live && shell.shipped ? shell.shipped.address : shell.address}
			accent={
				deployFlash > 0.05
					? colors.primary
					: landed.length >= 5 && built === 0
						? 'oklch(0.75 0.16 25 / 0.7)'
						: undefined
			}
			style={{
				left: mix(x, 960, collapse * 0.3) - windowWidth / 2 + shake,
				top: mix(y, 452, collapse * 0.3) - windowHeight / 2,
				opacity: Math.min(1, enter * 1.4) * (1 - leave),
				transform: `translateY(${mix(70, 0, enter) + slump * 26}px) rotate(${shell.slump * slump}deg) scale(${scale * mix(0.94, 1, enter) * mix(1, 0.9, leave)})`,
				filter: `grayscale(${slump * 0.55}) brightness(${1 - slump * 0.2})${leave > 0 ? ` blur(${leave * 10}px)` : ''}`,
				boxShadow: `0 40px 90px oklch(0 0 0 / 0.55), 0 0 ${deployFlash * 60}px ${colors.primary}`,
			}}
		>
			<AppBody steps={landed.length} built={built} live={live} frame={frame} />
			{shell.cardTimes.map((landedAt, index) => (
				<SetupModal
					key={index}
					card={setupCards[index]!}
					landedAt={landedAt}
					clearAt={shell.shipped ? cue.build.start : undefined}
					frame={frame}
				/>
			))}
		</AppWindow>
	)
}

const checklist = [
	{
		label: 'Wire up integrations',
		start: cue.wire.start,
		done: cue.build.start,
	},
	{ label: 'Build', start: cue.build.start, done: cue.build.end },
	{ label: 'Deploy', start: cue.deploy.start, done: cue.deploy.end },
] as const

function Checklist({ frame }: { frame: number }) {
	const leave = progress(
		frame,
		cue.needAnother - 6,
		cue.needAnother + 4,
		easeIn,
	)
	return (
		<div
			style={{
				position: 'absolute',
				left: 124,
				top: 600,
				display: 'grid',
				gap: 22,
				opacity: 1 - leave,
				transform: `translateY(${leave * -16}px)`,
			}}
		>
			{checklist.map((item, index) => {
				const show = settle(frame, cue.checklist + index * 4)
				const active = frame >= item.start && frame < item.done
				const done = frame >= item.done
				const tick = settle(frame, item.done, { damping: 12, stiffness: 200 })
				return (
					<div
						key={item.label}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 20,
							opacity: show * (done || active ? 1 : 0.5),
							transform: `translateX(${mix(-24, 0, show)}px)`,
						}}
					>
						<div style={{ width: 44, height: 44, position: 'relative' }}>
							<svg width={44} height={44} viewBox="0 0 44 44">
								<circle
									cx={22}
									cy={22}
									r={19}
									fill={done ? colors.primary : 'none'}
									stroke={
										done
											? colors.primary
											: active
												? colors.warning
												: colors.fieldBorder
									}
									strokeWidth={3}
									strokeDasharray={active ? '60 60' : undefined}
									transform={active ? `rotate(${frame * 14} 22 22)` : undefined}
								/>
								{done ? (
									<path
										d="M13 22.5l6 6 12-13"
										fill="none"
										stroke={colors.onPrimary}
										strokeWidth={4}
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeDasharray={30}
										strokeDashoffset={30 * (1 - tick)}
									/>
								) : null}
							</svg>
						</div>
						<div
							style={{
								fontFamily: fonts.display,
								fontWeight: 700,
								fontSize: 44,
								color: active
									? colors.text
									: done
										? colors.textMuted
										: colors.textMuted,
							}}
						>
							{item.label}
						</div>
					</div>
				)
			})}
		</div>
	)
}

function Ugh({ frame }: { frame: number }) {
	if (frame < cue.ugh - 1) return null
	const pop = settle(frame, cue.ugh, { damping: 9, stiffness: 180 })
	const emoji = settle(frame, cue.ugh + 5, { damping: 8, stiffness: 160 })
	const leave = progress(frame, cue.exit, cue.exit + 12, easeIn)
	return (
		<div
			style={{
				position: 'absolute',
				left: 120,
				top: 330,
				display: 'flex',
				alignItems: 'center',
				gap: 34,
				opacity: Math.min(1, pop * 1.5) * (1 - leave),
				transform: `scale(${mix(0.7, 1, pop)}) translateY(${leave * -20}px)`,
				transformOrigin: 'left center',
				filter: leave > 0 ? `blur(${leave * 10}px)` : undefined,
			}}
		>
			<div
				style={{
					fontFamily: fonts.display,
					fontWeight: 800,
					fontSize: 230,
					letterSpacing: '-0.03em',
					color: colors.text,
				}}
			>
				Ugh
			</div>
			<Img
				src={wearyFace}
				style={{
					width: 190,
					height: 190,
					transform: `scale(${mix(0.3, 1, emoji)}) rotate(${mix(-25, 0, emoji)}deg)`,
					opacity: Math.min(1, emoji * 2),
				}}
			/>
		</div>
	)
}

export function IntegrationTax() {
	const frame = useCurrentFrame() + scenes.integrationTax.from
	const againSizes = [60, 54, 48]
	return (
		<AbsoluteFill>
			{shells.map((shell) => (
				<Shell key={shell.title} shell={shell} frame={frame} />
			))}
			<Headline
				frame={frame}
				lines={[words('You need a'), words('new app.')]}
				enterAt={cue.needApp}
				exitAt={cue.needAnother - 6}
				fontSize={104}
				style={{ left: 120, top: 300 }}
			/>
			<Checklist frame={frame} />
			<Headline
				frame={frame}
				lines={[words('Now you need'), words('another one.')]}
				enterAt={cue.needAnother}
				exitAt={cue.again - 6}
				fontSize={104}
				style={{ left: 120, top: 360 }}
			/>
			<div style={{ opacity: 1 - progress(frame, cue.ugh - 2, cue.ugh + 1) }}>
				<Headline
					frame={frame}
					lines={[
						words('Wire up integrations…'),
						[{ text: 'again.', color: colors.danger, at: cue.again + 8 }],
					]}
					enterAt={cue.again}
					exitAt={cue.ugh + 30}
					fontSize={72}
					stagger={2}
					style={{ left: 120, top: 260 }}
				/>
				{cue.andAgain.map((at, index) => (
					<div key={at} style={{ opacity: 1 - index * 0.14 }}>
						<Headline
							frame={frame}
							lines={[
								[
									{ text: 'and', color: colors.danger, at },
									{ text: 'again…', color: colors.danger, at: at + 2 },
								],
							]}
							enterAt={at}
							exitAt={cue.ugh + 30}
							fontSize={againSizes[index]!}
							style={{ left: 120, top: 424 + index * 72 }}
						/>
					</div>
				))}
			</div>
			<Ugh frame={frame} />
		</AbsoluteFill>
	)
}
