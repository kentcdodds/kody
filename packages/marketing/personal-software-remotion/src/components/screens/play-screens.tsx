import { colors, fonts, primitiveColors } from '../../theme.ts'
import {
	Avatar,
	Button,
	Label,
	Panel,
	Screen,
	tint,
	type ScreenProps,
} from './parts.tsx'

export function PlayerScreen({ age, accent, marks }: ScreenProps) {
	const played = 0.34 + age / 900
	return (
		<Screen heading="Deep work" marks={marks}>
			<div style={{ display: 'flex', gap: 44, height: '100%' }}>
				<div
					style={{
						width: 420,
						height: 420,
						borderRadius: 30,
						flexShrink: 0,
						background: `conic-gradient(from ${age * 2}deg, ${accent}, ${primitiveColors.packages}, ${primitiveColors.secrets}, ${accent})`,
						display: 'grid',
						placeItems: 'center',
					}}
				>
					<div
						style={{
							width: 120,
							height: 120,
							borderRadius: '50%',
							background: colors.canvas,
						}}
					/>
				</div>
				<div
					style={{ flex: 1, display: 'grid', alignContent: 'center', gap: 20 }}
				>
					<Label size={48} weight={800} style={{ fontFamily: fonts.display }}>
						Low Light Drive
					</Label>
					<Label size={32} muted>
						Focus mix · 2h 10m today
					</Label>
					<div
						style={{
							height: 16,
							borderRadius: 8,
							background: colors.surfaceRaised,
							marginTop: 20,
						}}
					>
						<div
							style={{
								width: `${played * 100}%`,
								height: '100%',
								borderRadius: 8,
								background: accent,
							}}
						/>
					</div>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 50,
							marginTop: 18,
						}}
					>
						<svg width={60} height={60} viewBox="0 0 60 60">
							<path
								d="M50 10 L22 30 L50 50 Z M14 10 H22 V50 H14 Z"
								fill={colors.text}
							/>
						</svg>
						<div
							style={{
								width: 124,
								height: 124,
								borderRadius: '50%',
								background: colors.text,
								display: 'grid',
								placeItems: 'center',
							}}
						>
							<svg width={50} height={50} viewBox="0 0 50 50">
								<path
									d="M10 6 H20 V44 H10 Z M30 6 H40 V44 H30 Z"
									fill={colors.canvas}
								/>
							</svg>
						</div>
						<svg width={60} height={60} viewBox="0 0 60 60">
							<path
								d="M10 10 L38 30 L10 50 Z M38 10 H46 V50 H38 Z"
								fill={colors.text}
							/>
						</svg>
					</div>
				</div>
			</div>
		</Screen>
	)
}

export function TimerScreen({ age, accent, marks }: ScreenProps) {
	const seconds = Math.max(0, 42 - Math.floor(age / 30))
	const left = (42 - age / 30) / 60
	const radius = 170
	const circumference = 2 * Math.PI * radius
	return (
		<Screen heading="Intervals" marks={marks}>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 60,
					height: '100%',
				}}
			>
				<div style={{ position: 'relative', width: 400, height: 400 }}>
					<svg width={400} height={400} style={{ transform: 'rotate(-90deg)' }}>
						<circle
							cx={200}
							cy={200}
							r={radius}
							fill="none"
							stroke={colors.surfaceRaised}
							strokeWidth={34}
						/>
						<circle
							cx={200}
							cy={200}
							r={radius}
							fill="none"
							stroke={accent}
							strokeWidth={34}
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={circumference * (1 - left)}
						/>
					</svg>
					<div
						style={{
							position: 'absolute',
							inset: 0,
							display: 'grid',
							placeItems: 'center',
							fontFamily: fonts.display,
							fontWeight: 800,
							fontSize: 110,
						}}
					>
						0:{String(seconds).padStart(2, '0')}
					</div>
				</div>
				<div style={{ display: 'grid', gap: 26 }}>
					<Label size={44} weight={800} style={{ fontFamily: fonts.display }}>
						Round 3 of 8
					</Label>
					<Label size={32} muted>
						Next: 30s rest
					</Label>
					<div style={{ display: 'flex', gap: 18, marginTop: 20 }}>
						<Button color={accent} ink={colors.canvas}>
							Pause
						</Button>
						<Button outline color={colors.fieldBorder}>
							Skip
						</Button>
					</div>
				</div>
			</div>
		</Screen>
	)
}

const correctColor = primitiveColors.integrations

export function FlashcardScreen({ age, marks }: ScreenProps) {
	const answered = age > 18
	const choices = ['the library', 'the bookstore', 'the museum', 'the bakery']
	return (
		<Screen heading="Spanish · card 12 of 30" marks={marks}>
			<Panel
				style={{
					height: 200,
					display: 'grid',
					placeItems: 'center',
					marginBottom: 24,
					background: colors.surfaceRaised,
				}}
			>
				<div
					style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 76 }}
				>
					la biblioteca
				</div>
			</Panel>
			<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
				{choices.map((choice, index) => {
					const correct = answered && index === 0
					return (
						<div
							key={choice}
							style={{
								height: 110,
								borderRadius: 22,
								display: 'grid',
								placeItems: 'center',
								fontSize: 36,
								fontWeight: 700,
								background: correct ? correctColor : colors.surface,
								color: correct ? colors.canvas : colors.text,
								border: `2px solid ${correct ? correctColor : colors.border}`,
							}}
						>
							{choice}
						</div>
					)
				})}
			</div>
		</Screen>
	)
}

export function PollScreen({ age, accent, marks }: ScreenProps) {
	const voted = age > 14
	const options = [
		{ name: 'Tacos', share: voted ? 0.62 : 0.55 },
		{ name: 'Pho', share: 0.24 },
		{ name: 'Pizza', share: voted ? 0.14 : 0.21 },
	]
	const voters = [
		primitiveColors.memory,
		primitiveColors.packages,
		primitiveColors.triggers,
		primitiveColors.apps,
	]
	return (
		<Screen heading="Friday lunch?" marks={marks}>
			<div style={{ display: 'grid', gap: 22 }}>
				{options.map((option, index) => (
					<div
						key={option.name}
						style={{
							position: 'relative',
							height: 96,
							borderRadius: 24,
							overflow: 'hidden',
							border: `3px solid ${index === 0 && voted ? accent : colors.border}`,
							background: colors.surface,
						}}
					>
						<div
							style={{
								position: 'absolute',
								inset: 0,
								width: `${option.share * 100}%`,
								background: tint(
									index === 0 ? accent : colors.fieldBorder,
									0.35,
								),
							}}
						/>
						<div
							style={{
								position: 'absolute',
								inset: 0,
								display: 'flex',
								alignItems: 'center',
								gap: 22,
								padding: '0 28px',
							}}
						>
							<div
								style={{
									width: 40,
									height: 40,
									borderRadius: '50%',
									border: `4px solid ${index === 0 && voted ? accent : colors.fieldBorder}`,
									background: index === 0 && voted ? accent : 'transparent',
								}}
							/>
							<Label size={38} weight={700} style={{ marginRight: 'auto' }}>
								{option.name}
							</Label>
							<Label size={34} weight={800}>
								{Math.round(option.share * 100)}%
							</Label>
						</div>
					</div>
				))}
			</div>
			<div
				style={{ position: 'absolute', left: 0, bottom: 0, display: 'flex' }}
			>
				{voters.map((color, index) => (
					<div key={color} style={{ marginLeft: index === 0 ? 0 : -18 }}>
						<Avatar initial={'KMJA'[index]!} color={color} size={62} />
					</div>
				))}
			</div>
		</Screen>
	)
}

export function SketchScreen({ age, accent, marks }: ScreenProps) {
	const drawn = Math.min(1, age / 40)
	const palette = [
		accent,
		primitiveColors.triggers,
		primitiveColors.packages,
		primitiveColors.memory,
		colors.text,
	]
	return (
		<Screen heading="Dragon, take 2" marks={marks}>
			<div style={{ display: 'flex', gap: 24, height: '100%' }}>
				<Panel
					style={{
						width: 104,
						padding: '22px 0',
						display: 'grid',
						justifyItems: 'center',
						alignContent: 'start',
						gap: 20,
					}}
				>
					{palette.map((color, index) => (
						<div
							key={color}
							style={{
								width: 58,
								height: 58,
								borderRadius: '50%',
								background: color,
								outline: index === 0 ? `5px solid ${colors.text}` : undefined,
								outlineOffset: 5,
							}}
						/>
					))}
				</Panel>
				<Panel
					style={{
						flex: 1,
						background: 'oklch(0.93 0.01 90)',
						overflow: 'hidden',
					}}
				>
					<svg width={958} height={506}>
						<path
							d="M 120 380 C 180 200, 330 160, 420 250 S 600 380, 680 230 C 720 150, 800 130, 850 190"
							fill="none"
							stroke={accent}
							strokeWidth={30}
							strokeLinecap="round"
							strokeDasharray={1400}
							strokeDashoffset={1400 * (1 - drawn)}
						/>
						<path
							d="M 400 250 L 440 150 L 480 250 M 560 300 L 600 200 L 640 290"
							fill="none"
							stroke={primitiveColors.packages}
							strokeWidth={18}
							strokeLinejoin="round"
							strokeLinecap="round"
						/>
						<circle cx={835} cy={180} r={14} fill={colors.canvas} />
						<path
							d="M 870 200 C 910 190, 930 230, 900 250 M 880 170 C 930 150, 950 190, 930 205"
							fill="none"
							stroke={primitiveColors.triggers}
							strokeWidth={14}
							strokeLinecap="round"
						/>
					</svg>
				</Panel>
			</div>
		</Screen>
	)
}

type Guess = { word: string; marks: string }

export function WordScreen({ age, accent, marks }: ScreenProps) {
	const present = primitiveColors.triggers
	const guesses: Array<Guess> = [
		{ word: 'CRANE', marks: 'xyxxg' },
		{ word: 'SLOPE', marks: 'xgyxg' },
		{ word: 'GLOBE', marks: 'ggggg' },
	]
	const shownRows = Math.min(guesses.length, 1 + Math.floor(age / 10))
	const fill = (mark: string) =>
		mark === 'g' ? correctColor : mark === 'y' ? present : colors.surfaceRaised
	return (
		<Screen heading="Daily word #318" marks={marks}>
			<div
				style={{
					display: 'flex',
					gap: 60,
					height: '100%',
					alignItems: 'center',
				}}
			>
				<div style={{ display: 'grid', gap: 12 }}>
					{Array.from({ length: 5 }, (_, row) => {
						const guess = row < shownRows ? guesses[row] : undefined
						return (
							<div key={row} style={{ display: 'flex', gap: 12 }}>
								{Array.from({ length: 5 }, (_, column) => (
									<div
										key={column}
										style={{
											width: 84,
											height: 84,
											borderRadius: 14,
											display: 'grid',
											placeItems: 'center',
											fontFamily: fonts.display,
											fontWeight: 800,
											fontSize: 48,
											background: guess
												? fill(guess.marks[column]!)
												: 'transparent',
											border: guess ? 'none' : `3px solid ${colors.border}`,
											color:
												guess?.marks[column] === 'x'
													? colors.text
													: colors.canvas,
										}}
									>
										{guess?.word[column]}
									</div>
								))}
							</div>
						)
					})}
				</div>
				<div style={{ display: 'grid', gap: 16 }}>
					<Label size={100} weight={800} style={{ fontFamily: fonts.display }}>
						12
					</Label>
					<Label size={32} muted>
						day streak
					</Label>
					<Button color={accent} ink={colors.canvas} style={{ marginTop: 20 }}>
						Share
					</Button>
				</div>
			</div>
		</Screen>
	)
}

export function SeatScreen({ accent, marks }: ScreenProps) {
	const rows = 5
	const taken = new Set([
		'0-1',
		'0-4',
		'1-0',
		'1-2',
		'2-5',
		'3-1',
		'3-3',
		'4-4',
	])
	const picked = '2-2'
	return (
		<Screen heading="SLC → Denver · pick a seat" marks={marks}>
			<div
				style={{
					display: 'flex',
					gap: 50,
					height: '100%',
					alignItems: 'center',
				}}
			>
				<Panel style={{ padding: '26px 34px', display: 'grid', gap: 16 }}>
					{Array.from({ length: rows }, (_, row) => (
						<div key={row} style={{ display: 'flex', gap: 14 }}>
							{Array.from({ length: 6 }, (_, seat) => {
								const id = `${row}-${seat}`
								const isPicked = id === picked
								return (
									<div
										key={seat}
										style={{
											width: 62,
											height: 62,
											borderRadius: '16px 16px 10px 10px',
											marginLeft: seat === 3 ? 34 : 0,
											background: isPicked
												? accent
												: taken.has(id)
													? colors.border
													: colors.surfaceRaised,
											border: `3px solid ${isPicked ? accent : colors.fieldBorder}`,
											opacity: taken.has(id) ? 0.5 : 1,
										}}
									/>
								)
							})}
						</div>
					))}
				</Panel>
				<div style={{ display: 'grid', gap: 16 }}>
					<Label size={100} weight={800} style={{ fontFamily: fonts.display }}>
						14C
					</Label>
					<Label size={32} muted>
						Aisle · extra legroom
					</Label>
					<Button color={accent} ink={colors.canvas} style={{ marginTop: 20 }}>
						Confirm seat
					</Button>
				</div>
			</div>
		</Screen>
	)
}

export function HabitScreen({ age, accent, marks }: ScreenProps) {
	const columns = 16
	const markedToday = age > 16
	return (
		<Screen heading="Run every day" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: `repeat(${columns}, 1fr)`,
					gap: 10,
					marginBottom: 34,
				}}
			>
				{Array.from({ length: columns * 5 }, (_, index) => {
					const today = index === columns * 5 - 1
					const level = today ? (markedToday ? 1 : 0) : ((index * 37) % 11) / 10
					return (
						<div
							key={index}
							style={{
								aspectRatio: '1',
								borderRadius: 10,
								background:
									level < 0.2
										? colors.surfaceRaised
										: tint(accent, 0.25 + level * 0.75),
								outline: today ? `4px solid ${colors.text}` : undefined,
							}}
						/>
					)
				})}
			</div>
			<div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
				<Label size={40} weight={800} style={{ marginRight: 'auto' }}>
					{markedToday ? '24' : '23'}-day streak
				</Label>
				<Button color={accent} ink={colors.canvas}>
					{markedToday ? 'Done today' : 'Mark today'}
				</Button>
			</div>
		</Screen>
	)
}
