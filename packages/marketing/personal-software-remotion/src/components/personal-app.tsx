import { type ReactNode } from 'react'
import { cardFetches, cues, triggerTicks } from '../choreography.ts'
import { easeInOut, mix, presence, progress, pulse, settle } from '../motion.ts'
import { colors, fonts, primitiveColors } from '../theme.ts'
import { AppWindow } from './app-window.tsx'
import { MarkWell, type MarkId } from './mark.tsx'

export const appFrame = { left: 594, top: 286, width: 1190, height: 744 }

const bodyTop = appFrame.top + 58
const gridTop = 128
const cardGap = 24
const cardWidth = (appFrame.width - 60 - cardGap) / 2
const cardHeight = 250

/** Where each card's data port sits on the window's left edge. */
export function cardPort(index: number) {
	const row = Math.floor(index / 2)
	const column = index % 2
	return {
		x: appFrame.left,
		y: bodyTop + gridTop + row * (cardHeight + cardGap) + 70 + column * 90,
	}
}

type DayState = {
	day: string
	date: string
	events: ReadonlyArray<[string, string]>
	inbox: number
	emails: ReadonlyArray<[string, string]>
	reviews: number
	pulls: ReadonlyArray<string>
	mrr: number
	growth: string
	spark: ReadonlyArray<number>
}

const days: ReadonlyArray<DayState> = [
	{
		day: 'Monday',
		date: 'Sep 28',
		events: [
			['9:00', 'Team sync'],
			['11:30', 'Podcast recording'],
			['2:00', '1:1 with Sam'],
		],
		inbox: 3,
		emails: [
			['Sam Lee', 'Workshop dates?'],
			['Stripe', 'Payout on the way'],
		],
		reviews: 5,
		pulls: ['kody#412 Motion piece', 'kody#409 Faster search'],
		mrr: 12480,
		growth: '+8.2%',
		spark: [0.3, 0.38, 0.34, 0.5, 0.46, 0.62, 0.58, 0.74, 0.8],
	},
	{
		day: 'Tuesday',
		date: 'Sep 29',
		events: [
			['8:30', 'Gym'],
			['10:00', 'Design review'],
			['4:00', 'Office hours'],
		],
		inbox: 1,
		emails: [
			['Ana Ruiz', 'Invoice approved'],
			['GitHub', 'Review requested'],
		],
		reviews: 3,
		pulls: ['kody#415 Jobs retry', 'kody#412 Motion piece'],
		mrr: 12610,
		growth: '+8.9%',
		spark: [0.38, 0.34, 0.5, 0.46, 0.62, 0.58, 0.74, 0.8, 0.84],
	},
	{
		day: 'Wednesday',
		date: 'Sep 30',
		events: [
			['9:00', 'Team sync'],
			['1:00', 'Lunch with Jo'],
			['3:30', 'Record course'],
		],
		inbox: 4,
		emails: [
			['Jo Park', 'Lunch still on?'],
			['Linear', '2 issues assigned'],
		],
		reviews: 6,
		pulls: ['kody#418 Inbox rules', 'kody#417 Docs polish'],
		mrr: 12790,
		growth: '+9.6%',
		spark: [0.34, 0.5, 0.46, 0.62, 0.58, 0.74, 0.8, 0.84, 0.9],
	},
	{
		day: 'Thursday',
		date: 'Oct 1',
		events: [
			['7:30', 'School run'],
			['10:00', 'Podcast edit'],
			['2:00', 'Planning'],
		],
		inbox: 2,
		emails: [
			['Kit', 'Newsletter scheduled'],
			['Sam Lee', 'Dates confirmed'],
		],
		reviews: 2,
		pulls: ['kody#420 Webhook rotate', 'kody#418 Inbox rules'],
		mrr: 13020,
		growth: '+10.4%',
		spark: [0.5, 0.46, 0.62, 0.58, 0.74, 0.8, 0.84, 0.9, 0.96],
	},
]

function dayIndex(frame: number) {
	return triggerTicks.filter((tick) => frame >= tick + 4).length
}

function Card({
	index,
	frame,
	mark,
	label,
	children,
}: {
	index: number
	frame: number
	mark: MarkId
	label: string
	children: ReactNode
}) {
	const appear = settle(frame, cues.appBuild + 10 + index * 5, {
		damping: 17,
		stiffness: 130,
	})
	const fetched = progress(frame, cardFetches[index]!, cardFetches[index]! + 10)
	const flash =
		pulse(frame, cardFetches[index]!, 20) +
		triggerTicks.reduce((sum, tick) => sum + pulse(frame, tick + 4, 22), 0)
	const row = Math.floor(index / 2)
	const column = index % 2
	return (
		<div
			style={{
				position: 'absolute',
				left: 30 + column * (cardWidth + cardGap),
				top: gridTop + row * (cardHeight + cardGap),
				width: cardWidth,
				height: cardHeight,
				padding: '20px 24px',
				borderRadius: 20,
				background: colors.surface,
				border: `1.5px solid ${flash > 0.05 ? primitiveColors.integrations : colors.border}`,
				boxShadow: `0 0 ${flash * 36}px color-mix(in oklch, ${primitiveColors.integrations} ${Math.round(flash * 45)}%, transparent)`,
				opacity: appear,
				transform: `translateY(${mix(30, 0, appear)}px) scale(${mix(0.94, 1, appear)})`,
				overflow: 'hidden',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
				<MarkWell id={mark} size={36} />
				<div
					style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 24 }}
				>
					{label}
				</div>
				<div
					style={{
						marginLeft: 'auto',
						display: 'flex',
						alignItems: 'center',
						gap: 8,
						fontSize: 15,
						fontWeight: 700,
						color: primitiveColors.integrations,
						opacity: fetched,
					}}
				>
					<div
						style={{
							width: 9,
							height: 9,
							borderRadius: '50%',
							background: primitiveColors.integrations,
						}}
					/>
					via Kody
				</div>
			</div>
			<div style={{ position: 'relative', marginTop: 16 }}>
				<div style={{ opacity: fetched }}>{children}</div>
				<div style={{ position: 'absolute', inset: 0, opacity: 1 - fetched }}>
					{[0.8, 0.6, 0.7].map((share, line) => (
						<div
							key={line}
							style={{
								width: `${share * 100}%`,
								height: 18,
								marginTop: line === 0 ? 6 : 18,
								borderRadius: 9,
								background: colors.surfaceRaised,
								opacity: 0.6 + 0.4 * Math.sin(frame / 4 + line),
							}}
						/>
					))}
				</div>
			</div>
		</div>
	)
}

function Rows({ rows }: { rows: ReadonlyArray<[string, string]> }) {
	return (
		<div style={{ display: 'grid', gap: 10 }}>
			{rows.map(([lead, text]) => (
				<div
					key={lead + text}
					style={{
						display: 'flex',
						gap: 16,
						fontSize: 21,
						whiteSpace: 'nowrap',
					}}
				>
					<span
						style={{
							width: 96,
							flexShrink: 0,
							color: colors.textMuted,
							fontWeight: 600,
						}}
					>
						{lead}
					</span>
					<span>{text}</span>
				</div>
			))}
		</div>
	)
}

function BigNumber({ value, caption }: { value: string; caption: string }) {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'baseline',
				gap: 12,
				marginBottom: 10,
			}}
		>
			<span
				style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 44 }}
			>
				{value}
			</span>
			<span style={{ fontSize: 19, color: colors.textMuted }}>{caption}</span>
		</div>
	)
}

function Sparkline({
	values,
	draw,
}: {
	values: ReadonlyArray<number>
	draw: number
}) {
	const w = cardWidth - 48
	const h = 90
	const points = values.map((value, index) => ({
		x: (index / (values.length - 1)) * w,
		y: h - value * h,
	}))
	const d = points
		.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
		.join(' ')
	const area = `${d} L ${w} ${h} L 0 ${h} Z`
	return (
		<svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
			<defs>
				<linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor={colors.primary} stopOpacity={0.35} />
					<stop offset="100%" stopColor={colors.primary} stopOpacity={0} />
				</linearGradient>
			</defs>
			<path d={area} fill="url(#spark-fill)" opacity={draw} />
			<path
				d={d}
				fill="none"
				stroke={colors.primary}
				strokeWidth={4}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeDasharray={1400}
				strokeDashoffset={1400 * (1 - draw)}
			/>
		</svg>
	)
}

function HeaderPill({
	children,
	color,
	glow = 0,
}: {
	children: ReactNode
	color: string
	glow?: number
}) {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 9,
				padding: '9px 18px',
				borderRadius: 999,
				border: `1.5px solid ${color}`,
				color,
				fontWeight: 700,
				fontSize: 18,
				whiteSpace: 'nowrap',
				background: `color-mix(in oklch, ${color} ${Math.round(8 + glow * 30)}%, transparent)`,
				boxShadow: `0 0 ${glow * 30}px ${color}`,
				transform: `scale(${1 + glow * 0.08})`,
			}}
		>
			{children}
		</div>
	)
}

function Toast({ frame }: { frame: number }) {
	const tick = [...triggerTicks].reverse().find((at) => frame >= at)
	if (tick == null) return null
	const show = presence(frame, {
		in: tick + 2,
		out: tick + 26,
		enter: 8,
		exit: 8,
	})
	const rise = settle(frame, tick + 2)
	return (
		<div
			style={{
				position: 'absolute',
				right: 30,
				bottom: 24,
				display: 'flex',
				alignItems: 'center',
				gap: 12,
				padding: '12px 20px',
				borderRadius: 14,
				background: colors.surfaceRaised,
				border: `1.5px solid ${primitiveColors.triggers}`,
				fontSize: 19,
				fontWeight: 600,
				opacity: show,
				transform: `translateY(${mix(24, 0, rise)}px)`,
				boxShadow: '0 16px 40px oklch(0 0 0 / 0.45)',
			}}
		>
			<ClockGlyph color={primitiveColors.triggers} />
			7:00 AM · Morning digest sent
		</div>
	)
}

export function ClockGlyph({
	color,
	size = 20,
}: {
	color: string
	size?: number
}) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
			<circle
				cx="12"
				cy="12"
				r="9.5"
				fill="none"
				stroke={color}
				strokeWidth="2.4"
			/>
			<path
				d="M12 7v5.5l3.5 2"
				fill="none"
				stroke={color}
				strokeWidth="2.4"
				strokeLinecap="round"
			/>
		</svg>
	)
}

/**
 * The generated personal app. It builds in beat 3 and then keeps updating
 * itself in beat 4 on the package's own schedule.
 */
export function PersonalApp({ frame }: { frame: number }) {
	if (frame < cues.appBuild - 2) return null
	const grow = settle(frame, cues.appBuild, { damping: 20, stiffness: 90 })
	const state = days[Math.min(dayIndex(frame), days.length - 1)]!
	const tickGlow = triggerTicks.reduce(
		(sum, tick) => sum + pulse(frame, tick, 20),
		0,
	)
	const clipBottom = (1 - grow) * (appFrame.height - 100)
	const sparkDraw = progress(
		frame,
		cardFetches[3]!,
		cardFetches[3]! + 24,
		easeInOut,
	)
	const mrrShown =
		dayIndex(frame) === 0
			? Math.round(
					state.mrr *
						progress(frame, cardFetches[3]!, cardFetches[3]! + 20, easeInOut),
				)
			: state.mrr

	return (
		<AppWindow
			width={appFrame.width}
			height={appFrame.height}
			title="Morning HQ"
			address="kent.kody.run/packages/morning-hq"
			accent={`color-mix(in oklch, ${primitiveColors.apps} ${Math.round(40 * (1 - grow) + 25)}%, ${colors.border})`}
			style={{
				left: appFrame.left,
				top: appFrame.top,
				clipPath: `inset(0 0 ${clipBottom}px 0 round 22px)`,
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: 30,
					right: 30,
					top: 26,
					display: 'flex',
					alignItems: 'center',
					gap: 14,
					opacity: progress(frame, cues.appBuild + 6, cues.appBuild + 16),
				}}
			>
				<div>
					<div
						style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 40 }}
					>
						Good morning, Kent
					</div>
					<div style={{ fontSize: 20, color: colors.textMuted, marginTop: 2 }}>
						{state.day}, {state.date}
					</div>
				</div>
				<div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
					<HeaderPill color={primitiveColors.triggers} glow={tickGlow}>
						<ClockGlyph color={primitiveColors.triggers} size={18} />
						Weekdays 7:00 AM
					</HeaderPill>
					<HeaderPill color={colors.primary}>
						<div
							style={{
								width: 10,
								height: 10,
								borderRadius: '50%',
								background: colors.primary,
								opacity: 0.6 + 0.4 * Math.sin(frame / 5),
							}}
						/>
						Live · 0 setup steps
					</HeaderPill>
				</div>
			</div>
			<Card index={0} frame={frame} mark="google" label="Today">
				<Rows rows={state.events} />
			</Card>
			<Card index={1} frame={frame} mark="google" label="Inbox">
				<BigNumber value={String(state.inbox)} caption="need a reply" />
				<Rows rows={state.emails} />
			</Card>
			<Card index={2} frame={frame} mark="github" label="Pull requests">
				<BigNumber value={String(state.reviews)} caption="awaiting review" />
				<div
					style={{
						display: 'grid',
						gap: 8,
						fontSize: 20,
						fontFamily: fonts.mono,
					}}
				>
					{state.pulls.map((pull) => (
						<div
							key={pull}
							style={{ whiteSpace: 'nowrap', color: colors.textMuted }}
						>
							{pull}
						</div>
					))}
				</div>
			</Card>
			<Card index={3} frame={frame} mark="stripe" label="Revenue">
				<BigNumber
					value={`$${mrrShown.toLocaleString('en-US')}`}
					caption={`MRR · ${state.growth}`}
				/>
				<Sparkline values={state.spark} draw={sparkDraw} />
			</Card>
			<Toast frame={frame} />
		</AppWindow>
	)
}
