import { colors, fonts, primitiveColors } from '../../theme.ts'
import {
	Avatar,
	blink,
	Button,
	Label,
	Panel,
	Screen,
	TextLine,
	Toggle,
	tint,
	type ScreenProps,
} from './parts.tsx'

const people = {
	maya: { initial: 'M', color: primitiveColors.memory },
	jon: { initial: 'J', color: primitiveColors.packages },
	ana: { initial: 'A', color: primitiveColors.triggers },
	sam: { initial: 'S', color: primitiveColors.apps },
}

export function KanbanScreen({ age, accent, marks }: ScreenProps) {
	const columns = [
		{ title: 'To do', cards: [0.8, 0.6, 0.7] },
		{ title: 'Doing', cards: [0.66] },
		{ title: 'Done', cards: [0.7, 0.55] },
	]
	const drag = Math.sin(age / 14) * 10
	return (
		<Screen heading="Sprint 14" marks={marks}>
			<div style={{ display: 'flex', gap: 26, height: '100%' }}>
				{columns.map((column, columnIndex) => (
					<Panel
						key={column.title}
						style={{
							flex: 1,
							padding: 22,
							display: 'grid',
							gap: 18,
							alignContent: 'start',
						}}
					>
						<Label size={30} muted>
							{column.title}
						</Label>
						{column.cards.map((share, cardIndex) => (
							<div
								key={cardIndex}
								style={{
									height: 96,
									borderRadius: 18,
									background: colors.surfaceRaised,
									padding: '18px 20px',
									display: 'grid',
									gap: 14,
								}}
							>
								<TextLine
									width={`${share * 100}%`}
									color={colors.fieldBorder}
								/>
								<div style={{ display: 'flex', gap: 10 }}>
									<TextLine
										width={70}
										height={18}
										color={
											[
												accent,
												primitiveColors.packages,
												primitiveColors.triggers,
											][(columnIndex + cardIndex) % 3]
										}
									/>
								</div>
							</div>
						))}
						{columnIndex === 1 ? (
							<div
								style={{
									height: 96,
									borderRadius: 18,
									background: colors.surfaceRaised,
									border: `3px solid ${accent}`,
									boxShadow: '0 30px 50px oklch(0 0 0 / 0.5)',
									transform: `translate(${-40 + drag}px, 30px) rotate(-5deg)`,
									padding: '18px 20px',
									display: 'grid',
									gap: 14,
								}}
							>
								<TextLine width="74%" color={colors.text} />
								<TextLine width={70} height={18} color={accent} />
							</div>
						) : null}
					</Panel>
				))}
			</div>
		</Screen>
	)
}

export function ChatScreen({ age, accent, marks }: ScreenProps) {
	const bubbles = [
		{ from: 'them', text: 'My order never showed up' },
		{ from: 'me', text: 'So sorry! Refunding it now.' },
		{ from: 'them', text: 'Wow, that was fast. Thanks!' },
	]
	return (
		<Screen heading="Maya · order #4821" marks={marks}>
			<div style={{ display: 'grid', gap: 20 }}>
				{bubbles.map((bubble, index) => (
					<div
						key={index}
						style={{
							display: 'flex',
							alignItems: 'flex-end',
							gap: 16,
							justifyContent: bubble.from === 'me' ? 'flex-end' : 'flex-start',
						}}
					>
						{bubble.from === 'them' ? (
							<Avatar {...people.maya} size={60} />
						) : null}
						<div
							style={{
								padding: '20px 30px',
								borderRadius: 34,
								fontSize: 34,
								background:
									bubble.from === 'me' ? accent : colors.surfaceRaised,
								color: bubble.from === 'me' ? colors.canvas : colors.text,
								fontWeight: bubble.from === 'me' ? 700 : 500,
							}}
						>
							{bubble.text}
						</div>
					</div>
				))}
			</div>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					bottom: 0,
					height: 88,
					borderRadius: 999,
					background: colors.surface,
					border: `2px solid ${colors.fieldBorder}`,
					display: 'flex',
					alignItems: 'center',
					padding: '0 12px 0 34px',
					gap: 12,
				}}
			>
				<Label size={30} muted style={{ marginRight: 'auto' }}>
					Anything else I can help with?
					<span style={{ opacity: blink(age), color: colors.text }}>|</span>
				</Label>
				<div
					style={{
						width: 66,
						height: 66,
						borderRadius: '50%',
						background: accent,
						display: 'grid',
						placeItems: 'center',
					}}
				>
					<svg width={30} height={30} viewBox="0 0 30 30">
						<path d="M4 15 L26 4 L19 26 L15 17 Z" fill={colors.canvas} />
					</svg>
				</div>
			</div>
		</Screen>
	)
}

export function DiffScreen({ marks }: ScreenProps) {
	const lines: Array<{ sign: ' ' | '+' | '-'; code: string }> = [
		{ sign: ' ', code: 'async function charge(order) {' },
		{ sign: '-', code: '  return stripe.charge(order)' },
		{ sign: '+', code: '  return retry(() =>' },
		{ sign: '+', code: '    stripe.charge(order), 3)' },
		{ sign: ' ', code: '}' },
	]
	const green = 'oklch(0.72 0.17 148)'
	const red = 'oklch(0.7 0.17 25)'
	return (
		<Screen heading="#482 Retry failed charges" marks={marks}>
			<Panel style={{ overflow: 'hidden', background: colors.canvas }}>
				{lines.map((line, index) => (
					<div
						key={index}
						style={{
							display: 'flex',
							gap: 26,
							padding: '10px 28px',
							fontFamily: fonts.mono,
							fontSize: 32,
							background:
								line.sign === '+'
									? tint(green, 0.18)
									: line.sign === '-'
										? tint(red, 0.18)
										: 'transparent',
							color:
								line.sign === '+'
									? green
									: line.sign === '-'
										? red
										: colors.textMuted,
							whiteSpace: 'pre',
						}}
					>
						<span style={{ opacity: 0.6 }}>{40 + index}</span>
						<span>{line.sign}</span>
						<span
							style={{
								color: line.sign === ' ' ? colors.textMuted : colors.text,
							}}
						>
							{line.code}
						</span>
					</div>
				))}
			</Panel>
			<div
				style={{
					position: 'absolute',
					right: 0,
					bottom: 0,
					display: 'flex',
					gap: 20,
				}}
			>
				<Button outline color={colors.fieldBorder}>
					Comment
				</Button>
				<Button>Approve</Button>
			</div>
		</Screen>
	)
}

export function TerminalScreen({ age, marks }: ScreenProps) {
	const output = [
		{ text: '$ kody run repo-janitor', color: colors.text },
		{
			text: '✓ 37 merged branches deleted',
			color: primitiveColors.integrations,
		},
		{
			text: '✓ 4 stale PRs pinged in #eng',
			color: primitiveColors.integrations,
		},
		{
			text: '✓ labels synced across 9 repos',
			color: primitiveColors.integrations,
		},
	]
	const shown = Math.min(output.length, 1 + Math.floor(age / 6))
	return (
		<Screen heading="Nightly cleanup" marks={marks}>
			<Panel
				style={{
					height: '100%',
					background: 'oklch(0.12 0.01 255)',
					padding: '30px 36px',
					fontFamily: fonts.mono,
					fontSize: 34,
					display: 'grid',
					gap: 18,
					alignContent: 'start',
				}}
			>
				{output.slice(0, shown).map((line) => (
					<div
						key={line.text}
						style={{ color: line.color, whiteSpace: 'nowrap' }}
					>
						{line.text}
					</div>
				))}
				<div style={{ color: colors.text }}>
					$ <span style={{ opacity: blink(age) }}>▋</span>
				</div>
			</Panel>
			<Button style={{ position: 'absolute', right: 28, bottom: 28 }}>
				Run now
			</Button>
		</Screen>
	)
}

export function ApprovalsScreen({ accent, marks }: ScreenProps) {
	const requests = [
		{
			person: people.jon,
			name: 'Jon Park',
			amount: '$48.00',
			reason: 'Double charged',
		},
		{
			person: people.ana,
			name: 'Ana Ruiz',
			amount: '$129.00',
			reason: 'Wrong size',
		},
	]
	return (
		<Screen heading="Refund requests" marks={marks}>
			<div style={{ display: 'grid', gap: 26 }}>
				{requests.map((request) => (
					<Panel
						key={request.name}
						style={{
							padding: '26px 30px',
							display: 'flex',
							alignItems: 'center',
							gap: 24,
						}}
					>
						<Avatar {...request.person} size={80} />
						<div style={{ marginRight: 'auto', display: 'grid', gap: 8 }}>
							<Label size={36} weight={700}>
								{request.name} · {request.amount}
							</Label>
							<Label size={28} muted>
								{request.reason}
							</Label>
						</div>
						<Button outline color={colors.danger}>
							Deny
						</Button>
						<Button color={accent} ink={colors.canvas}>
							Approve
						</Button>
					</Panel>
				))}
			</div>
		</Screen>
	)
}

export function CallScreen({ age, marks }: ScreenProps) {
	const tiles = [people.maya, people.jon, people.ana, people.sam]
	const speaking = Math.floor(age / 20) % tiles.length
	return (
		<Screen heading="Standup · 9:30" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: 18,
					height: 400,
				}}
			>
				{tiles.map((person, index) => (
					<div
						key={person.initial}
						style={{
							borderRadius: 24,
							background: `linear-gradient(135deg, ${tint(person.color, 0.35)}, ${colors.surface})`,
							border: `4px solid ${index === speaking ? person.color : 'transparent'}`,
							display: 'grid',
							placeItems: 'center',
						}}
					>
						<Avatar {...person} size={110} />
					</div>
				))}
			</div>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					bottom: 0,
					display: 'flex',
					justifyContent: 'center',
					gap: 22,
				}}
			>
				{[colors.surfaceRaised, colors.surfaceRaised, colors.danger].map(
					(color, index) => (
						<div
							key={index}
							style={{
								width: index === 2 ? 130 : 70,
								height: 70,
								borderRadius: 999,
								background: color,
							}}
						/>
					),
				)}
			</div>
		</Screen>
	)
}

export function EditorScreen({ age, accent, marks }: ScreenProps) {
	return (
		<Screen heading="Newsletter #37" marks={marks}>
			<div style={{ display: 'flex', gap: 12, marginBottom: 26 }}>
				{['B', 'I', 'U', 'H1', 'Link'].map((tool) => (
					<div
						key={tool}
						style={{
							padding: '10px 22px',
							borderRadius: 14,
							background: colors.surface,
							fontFamily: fonts.display,
							fontWeight: 800,
							fontSize: 28,
						}}
					>
						{tool}
					</div>
				))}
				<Button
					color={accent}
					ink={colors.canvas}
					style={{ marginLeft: 'auto', height: 62, fontSize: 28 }}
				>
					Publish
				</Button>
			</div>
			<div
				style={{
					fontFamily: fonts.display,
					fontWeight: 800,
					fontSize: 54,
					marginBottom: 22,
				}}
			>
				What I shipped this week
				<span style={{ opacity: blink(age), color: accent }}>|</span>
			</div>
			<div style={{ display: 'grid', gap: 18 }}>
				<TextLine width="96%" />
				<TextLine width="88%" />
				<div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
					<div
						style={{
							width: 260,
							height: 150,
							borderRadius: 18,
							background: `linear-gradient(135deg, ${accent}, ${primitiveColors.packages})`,
						}}
					/>
					<div style={{ display: 'grid', gap: 18, flex: 1 }}>
						<TextLine width="90%" />
						<TextLine width="70%" />
						<TextLine width="80%" />
					</div>
				</div>
			</div>
		</Screen>
	)
}

export function InvoiceScreen({ accent, marks }: ScreenProps) {
	const fields = [
		{ label: 'Client', value: 'Acme Studio' },
		{ label: 'Amount', value: '$2,400.00' },
		{ label: 'Due', value: 'Nov 1' },
		{ label: 'Memo', value: 'October retainer' },
	]
	return (
		<Screen heading="New invoice" marks={marks}>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: '22px 28px',
				}}
			>
				{fields.map((field) => (
					<div key={field.label} style={{ display: 'grid', gap: 10 }}>
						<Label size={26} muted>
							{field.label}
						</Label>
						<div
							style={{
								height: 78,
								borderRadius: 18,
								border: `2px solid ${colors.fieldBorder}`,
								background: colors.canvas,
								display: 'flex',
								alignItems: 'center',
								padding: '0 26px',
								fontSize: 34,
								fontWeight: 600,
							}}
						>
							{field.value}
						</div>
					</div>
				))}
			</div>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					bottom: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 20,
				}}
			>
				<Toggle on color={accent} />
				<Label size={30} muted style={{ marginRight: 'auto' }}>
					Remind them in 3 days
				</Label>
				<Button color={accent} ink={colors.canvas}>
					Send invoice
				</Button>
			</div>
		</Screen>
	)
}
