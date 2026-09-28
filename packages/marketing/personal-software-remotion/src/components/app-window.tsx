import { type CSSProperties, type ReactNode } from 'react'
import { colors, fonts } from '../theme.ts'

/** Browser-ish app shell. Size is fixed; callers move it with `style`. */
export function AppWindow({
	width,
	height,
	title,
	address,
	children,
	style,
	accent,
}: {
	width: number
	height: number
	title: string
	address: string
	children?: ReactNode
	style?: CSSProperties
	accent?: string
}) {
	return (
		<div
			style={{
				position: 'absolute',
				width,
				height,
				borderRadius: 22,
				background: colors.background,
				border: `1.5px solid ${accent ?? colors.border}`,
				boxShadow:
					'0 40px 90px oklch(0 0 0 / 0.55), 0 0 0 1px oklch(1 0 0 / 0.03) inset',
				overflow: 'hidden',
				fontFamily: fonts.body,
				color: colors.text,
				...style,
			}}
		>
			<div
				style={{
					height: 58,
					display: 'flex',
					alignItems: 'center',
					gap: 18,
					padding: '0 22px',
					background: colors.surface,
					borderBottom: `1px solid ${colors.border}`,
				}}
			>
				<div style={{ display: 'flex', gap: 9 }}>
					{[
						'oklch(0.7 0.16 25)',
						'oklch(0.82 0.14 85)',
						'oklch(0.74 0.16 145)',
					].map((color) => (
						<div
							key={color}
							style={{
								width: 14,
								height: 14,
								borderRadius: '50%',
								background: color,
								opacity: 0.85,
							}}
						/>
					))}
				</div>
				<div
					style={{
						fontFamily: fonts.display,
						fontWeight: 700,
						fontSize: 22,
						whiteSpace: 'nowrap',
					}}
				>
					{title}
				</div>
				<div
					style={{
						marginLeft: 'auto',
						padding: '7px 16px',
						borderRadius: 999,
						background: colors.background,
						border: `1px solid ${colors.border}`,
						color: colors.textMuted,
						fontSize: 17,
						fontFamily: fonts.mono,
						whiteSpace: 'nowrap',
					}}
				>
					{address}
				</div>
			</div>
			<div style={{ position: 'relative', height: height - 58 }}>
				{children}
			</div>
		</div>
	)
}
