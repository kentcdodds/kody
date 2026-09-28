import { colors, fonts, primitiveColors } from '../../theme.ts'
import {
	Avatar,
	Button,
	Check,
	Label,
	Panel,
	Screen,
	TextLine,
	Toggle,
	tint,
	type ScreenProps,
} from './parts.tsx'

export function BookingScreen({ accent, marks }: ScreenProps) {
	const slots = [
		'9:00',
		'9:30',
		'10:00',
		'10:30',
		'11:00',
		'1:00',
		'1:30',
		'2:00',
		'3:30',
	]
	const taken = new Set(['9:30', '11:00', '1:30'])
	const picked = '10:30'
	return (
		<Screen heading="Office hours · Fri" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(3, 1fr)',
					gap: 20,
				}}
			>
				{slots.map((slot) => {
					const isTaken = taken.has(slot)
					const isPicked = slot === picked
					return (
						<div
							key={slot}
							style={{
								height: 86,
								borderRadius: 20,
								display: 'grid',
								placeItems: 'center',
								fontFamily: fonts.display,
								fontWeight: 700,
								fontSize: 36,
								background: isPicked ? accent : colors.surface,
								color: isPicked
									? colors.canvas
									: isTaken
										? colors.border
										: colors.text,
								border: `2px solid ${isPicked ? accent : colors.border}`,
								textDecoration: isTaken ? 'line-through' : undefined,
							}}
						>
							{slot}
						</div>
					)
				})}
			</div>
			<Button
				color={accent}
				ink={colors.canvas}
				style={{ position: 'absolute', right: 0, bottom: 0 }}
			>
				Book 10:30
			</Button>
		</Screen>
	)
}

export function ChoresScreen({ age, accent, marks }: ScreenProps) {
	const chores = [
		{ task: 'Take out recycling', who: 'E', done: true },
		{ task: 'Feed the dog', who: 'L', done: true },
		{ task: 'Vacuum the stairs', who: 'S', done: age > 20 },
		{ task: 'Water the plants', who: 'E', done: false },
	]
	const whoColor: Record<string, string> = {
		E: primitiveColors.memory,
		L: primitiveColors.packages,
		S: primitiveColors.triggers,
	}
	return (
		<Screen heading="Chores this week" marks={marks}>
			<div style={{ display: 'grid', gap: 18 }}>
				{chores.map((chore) => (
					<Panel
						key={chore.task}
						style={{
							padding: '16px 26px',
							display: 'flex',
							alignItems: 'center',
							gap: 24,
						}}
					>
						<Check done={chore.done} color={accent} />
						<Label
							size={36}
							muted={chore.done}
							style={{
								marginRight: 'auto',
								textDecoration: chore.done ? 'line-through' : undefined,
							}}
						>
							{chore.task}
						</Label>
						<Avatar
							initial={chore.who}
							color={whoColor[chore.who]!}
							size={58}
						/>
					</Panel>
				))}
			</div>
		</Screen>
	)
}

export function RouteScreen({ age, accent, marks }: ScreenProps) {
	const route = 'M 80 400 C 220 380, 240 200, 420 220 S 640 120, 760 90'
	const drawn = Math.min(1, age / 30)
	return (
		<Screen heading="Moab → Zion" marks={marks}>
			<Panel
				style={{
					position: 'absolute',
					inset: 0,
					overflow: 'hidden',
					background: 'oklch(0.22 0.02 160)',
				}}
			>
				<svg width={1086} height={506} style={{ position: 'absolute' }}>
					<ellipse
						cx={260}
						cy={120}
						rx={220}
						ry={90}
						fill="oklch(0.26 0.03 150)"
					/>
					<ellipse
						cx={640}
						cy={380}
						rx={260}
						ry={110}
						fill="oklch(0.25 0.03 60)"
					/>
					<path
						d="M 0 300 L 1086 180 M 300 0 L 380 506 M 0 90 L 900 470"
						stroke="oklch(0.32 0.02 160)"
						strokeWidth={10}
					/>
					<path
						d={route}
						fill="none"
						stroke={accent}
						strokeWidth={14}
						strokeLinecap="round"
						strokeDasharray="1100"
						strokeDashoffset={1100 * (1 - drawn)}
					/>
					{[
						{ x: 80, y: 400 },
						{ x: 420, y: 220 },
						{ x: 760, y: 90 },
					].map((pin, index) => (
						<g key={index}>
							<circle
								cx={pin.x}
								cy={pin.y}
								r={26}
								fill={index === 2 ? accent : colors.text}
							/>
							<circle cx={pin.x} cy={pin.y} r={10} fill={colors.canvas} />
						</g>
					))}
				</svg>
				<div
					style={{
						position: 'absolute',
						right: 28,
						bottom: 28,
						padding: '22px 28px',
						borderRadius: 24,
						background: colors.surface,
						display: 'flex',
						alignItems: 'center',
						gap: 26,
					}}
				>
					<div style={{ display: 'grid', gap: 4 }}>
						<Label size={38} weight={800}>
							5h 40m
						</Label>
						<Label size={26} muted>
							2 stops · gas on the way
						</Label>
					</div>
					<Button color={accent} ink={colors.canvas}>
						Start
					</Button>
				</div>
			</Panel>
		</Screen>
	)
}

export function PhotosScreen({ accent, marks }: ScreenProps) {
	const hues = [30, 80, 150, 200, 260, 320, 10, 110]
	return (
		<Screen heading="Fall 2026" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(4, 1fr)',
					gridTemplateRows: '1fr 1fr',
					gap: 16,
					height: 400,
				}}
			>
				{hues.map((hue, index) => (
					<div
						key={hue}
						style={{
							position: 'relative',
							borderRadius: 20,
							background: `radial-gradient(circle at 30% 30%, oklch(0.8 0.12 ${hue}), oklch(0.42 0.1 ${hue + 40}))`,
							outline: index === 2 ? `6px solid ${accent}` : undefined,
							outlineOffset: -6,
						}}
					>
						{index === 2 ? (
							<div
								style={{
									position: 'absolute',
									right: 14,
									top: 14,
									width: 44,
									height: 44,
									borderRadius: '50%',
									background: accent,
								}}
							/>
						) : null}
					</div>
				))}
			</div>
			<Button
				color={accent}
				ink={colors.canvas}
				style={{ position: 'absolute', right: 0, bottom: 0, height: 66 }}
			>
				Share with Grandma
			</Button>
		</Screen>
	)
}

export function GroceryScreen({ age, accent, marks }: ScreenProps) {
	const items = [
		{ name: 'Oat milk', count: 2 },
		{ name: 'Blueberries', count: age > 16 ? 4 : 3 },
		{ name: 'Tortillas', count: 1 },
	]
	return (
		<Screen heading="Costco run" marks={marks}>
			<div style={{ display: 'grid', gap: 18 }}>
				{items.map((item) => (
					<Panel
						key={item.name}
						style={{
							padding: '14px 18px 14px 30px',
							display: 'flex',
							alignItems: 'center',
							gap: 20,
						}}
					>
						<Label size={36} style={{ marginRight: 'auto' }}>
							{item.name}
						</Label>
						{['−', String(item.count), '+'].map((part, index) => (
							<div
								key={index}
								style={{
									width: index === 1 ? 70 : 66,
									height: 66,
									borderRadius: 18,
									display: 'grid',
									placeItems: 'center',
									fontFamily: fonts.display,
									fontWeight: 800,
									fontSize: 36,
									background:
										index === 1
											? 'transparent'
											: index === 2
												? accent
												: colors.surfaceRaised,
									color: index === 2 ? colors.canvas : colors.text,
								}}
							>
								{part}
							</div>
						))}
					</Panel>
				))}
			</div>
			<Button
				color={accent}
				ink={colors.canvas}
				style={{ position: 'absolute', right: 0, bottom: 0 }}
			>
				Order pickup
			</Button>
		</Screen>
	)
}

export function HomeScreen({ age, accent, marks }: ScreenProps) {
	const warm = primitiveColors.triggers
	return (
		<Screen heading="Living room" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: 22,
					height: '100%',
				}}
			>
				<Panel
					style={{
						padding: 30,
						display: 'grid',
						alignContent: 'space-between',
						background: tint(warm, 0.16),
						borderColor: warm,
					}}
				>
					<Label size={34} weight={700}>
						Lights
					</Label>
					<Toggle on color={warm} />
				</Panel>
				<Panel
					style={{
						padding: 30,
						display: 'grid',
						alignContent: 'space-between',
					}}
				>
					<Label size={34} weight={700}>
						Thermostat
					</Label>
					<div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
						<Label size={80} weight={800} style={{ fontFamily: fonts.display }}>
							{age > 24 ? 69 : 68}°
						</Label>
						<Button
							color={accent}
							ink={colors.canvas}
							style={{ padding: 0, width: 76 }}
						>
							+
						</Button>
					</div>
				</Panel>
				<Panel style={{ padding: 30, display: 'grid', gap: 24 }}>
					<Label size={34} weight={700}>
						Blinds
					</Label>
					<div
						style={{
							height: 20,
							borderRadius: 10,
							background: colors.surfaceRaised,
							position: 'relative',
						}}
					>
						<div
							style={{
								width: '60%',
								height: '100%',
								borderRadius: 10,
								background: accent,
							}}
						/>
						<div
							style={{
								position: 'absolute',
								left: 'calc(60% - 24px)',
								top: -14,
								width: 48,
								height: 48,
								borderRadius: '50%',
								background: colors.text,
							}}
						/>
					</div>
				</Panel>
				<Panel
					style={{
						padding: 30,
						display: 'grid',
						alignContent: 'space-between',
					}}
				>
					<Label size={34} weight={700}>
						Speaker
					</Label>
					<Toggle on={false} color={accent} />
				</Panel>
			</div>
		</Screen>
	)
}

function Face({
	mood,
	color,
	size,
}: {
	mood: number
	color: string
	size: number
}) {
	const curve = (mood - 2) * 7
	return (
		<svg width={size} height={size} viewBox="0 0 80 80">
			<circle cx={40} cy={40} r={36} fill={color} />
			<circle cx={28} cy={33} r={5} fill={colors.canvas} />
			<circle cx={52} cy={33} r={5} fill={colors.canvas} />
			<path
				d={`M 24 ${52 - curve / 2} Q 40 ${52 + curve} 56 ${52 - curve / 2}`}
				fill="none"
				stroke={colors.canvas}
				strokeWidth={5}
				strokeLinecap="round"
			/>
		</svg>
	)
}

export function JournalScreen({ accent, marks }: ScreenProps) {
	return (
		<Screen heading="Tuesday" marks={marks}>
			<div style={{ display: 'flex', gap: 22, marginBottom: 30 }}>
				{[0, 1, 2, 3, 4].map((mood) => (
					<div
						key={mood}
						style={{
							padding: 8,
							borderRadius: '50%',
							border: `5px solid ${mood === 4 ? accent : 'transparent'}`,
							opacity: mood === 4 ? 1 : 0.45,
						}}
					>
						<Face
							mood={mood}
							color={mood === 4 ? accent : colors.fieldBorder}
							size={92}
						/>
					</div>
				))}
			</div>
			<Label size={36} style={{ marginBottom: 20 }}>
				Kids made pancakes. Shipped the thing.
			</Label>
			<div style={{ display: 'grid', gap: 18 }}>
				<TextLine width="92%" />
				<TextLine width="64%" />
			</div>
			<Button
				color={accent}
				ink={colors.canvas}
				style={{ position: 'absolute', right: 0, bottom: 0 }}
			>
				Save entry
			</Button>
		</Screen>
	)
}

export function BudgetScreen({ age, accent, marks }: ScreenProps) {
	const envelopes = [
		{ name: 'Groceries', share: 0.62, amount: '$620' },
		{
			name: 'Fun money',
			share: 0.3 + Math.min(0.12, age / 300),
			amount: '$180',
		},
		{ name: 'Gifts', share: 0.45, amount: '$250' },
		{ name: 'Travel', share: 0.78, amount: '$900' },
	]
	return (
		<Screen heading="October budget" marks={marks}>
			<div style={{ display: 'grid', gap: 34 }}>
				{envelopes.map((envelope) => (
					<div
						key={envelope.name}
						style={{ display: 'flex', alignItems: 'center', gap: 30 }}
					>
						<Label size={32} style={{ width: 230 }}>
							{envelope.name}
						</Label>
						<div
							style={{
								flex: 1,
								height: 18,
								borderRadius: 9,
								background: colors.surfaceRaised,
								position: 'relative',
							}}
						>
							<div
								style={{
									width: `${envelope.share * 100}%`,
									height: '100%',
									borderRadius: 9,
									background: accent,
								}}
							/>
							<div
								style={{
									position: 'absolute',
									left: `calc(${envelope.share * 100}% - 22px)`,
									top: -13,
									width: 44,
									height: 44,
									borderRadius: '50%',
									background: colors.text,
									boxShadow: '0 6px 16px oklch(0 0 0 / 0.5)',
								}}
							/>
						</div>
						<Label
							size={34}
							weight={800}
							style={{ width: 130, textAlign: 'right' }}
						>
							{envelope.amount}
						</Label>
					</div>
				))}
			</div>
		</Screen>
	)
}
