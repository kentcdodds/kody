import { type CSSProperties, type ReactNode } from 'react'
import { colors, fonts } from '../../theme.ts'
import { MarkWell, type MarkId } from '../mark.tsx'

/**
 * Building blocks for the app tiles in the pull-back. Tiles are drawn at
 * 1190×744 world pixels and end up about 170px wide on screen, so every
 * screen leans on big, distinct shapes and keeps text short.
 */
export type ScreenProps = {
	/** Frames since this tile appeared. */
	age: number
	accent: string
	marks: ReadonlyArray<MarkId>
}

export const tint = (color: string, alpha: number) =>
	color.replace(')', ` / ${alpha})`)

export function Screen({
	heading,
	marks,
	children,
}: {
	heading: string
	marks: ReadonlyArray<MarkId>
	children: ReactNode
}) {
	return (
		<div style={{ position: 'absolute', inset: 0 }}>
			<div
				style={{
					position: 'absolute',
					left: 52,
					right: 52,
					top: 36,
					height: 72,
					display: 'flex',
					alignItems: 'center',
					gap: 14,
				}}
			>
				<div
					style={{
						fontFamily: fonts.display,
						fontWeight: 800,
						fontSize: 48,
						whiteSpace: 'nowrap',
						marginRight: 'auto',
					}}
				>
					{heading}
				</div>
				{marks.map((mark) => (
					<MarkWell key={mark} id={mark} size={62} />
				))}
			</div>
			<div
				style={{
					position: 'absolute',
					left: 52,
					right: 52,
					top: 136,
					bottom: 44,
				}}
			>
				{children}
			</div>
		</div>
	)
}

export function Button({
	children,
	color = colors.primary,
	ink = colors.onPrimary,
	outline = false,
	style,
}: {
	children: ReactNode
	color?: string
	ink?: string
	outline?: boolean
	style?: CSSProperties
}) {
	return (
		<div
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 14,
				height: 76,
				padding: '0 38px',
				borderRadius: 999,
				fontFamily: fonts.display,
				fontWeight: 700,
				fontSize: 34,
				whiteSpace: 'nowrap',
				background: outline ? 'transparent' : color,
				color: outline ? color : ink,
				border: `3px solid ${color}`,
				...style,
			}}
		>
			{children}
		</div>
	)
}

export function Panel({
	children,
	style,
}: {
	children?: ReactNode
	style?: CSSProperties
}) {
	return (
		<div
			style={{
				borderRadius: 26,
				background: colors.surface,
				border: `1.5px solid ${colors.border}`,
				...style,
			}}
		>
			{children}
		</div>
	)
}

export function Avatar({
	initial,
	color,
	size = 56,
}: {
	initial: string
	color: string
	size?: number
}) {
	return (
		<div
			style={{
				width: size,
				height: size,
				flexShrink: 0,
				borderRadius: '50%',
				display: 'grid',
				placeItems: 'center',
				background: color,
				color: colors.canvas,
				fontFamily: fonts.display,
				fontWeight: 800,
				fontSize: size * 0.48,
			}}
		>
			{initial}
		</div>
	)
}

export function Toggle({ on, color }: { on: boolean; color: string }) {
	return (
		<div
			style={{
				width: 104,
				height: 58,
				borderRadius: 999,
				padding: 6,
				background: on ? color : colors.surfaceRaised,
				display: 'flex',
				justifyContent: on ? 'flex-end' : 'flex-start',
			}}
		>
			<div
				style={{
					width: 46,
					height: 46,
					borderRadius: '50%',
					background: on ? colors.canvas : colors.fieldBorder,
				}}
			/>
		</div>
	)
}

export function Check({
	done,
	color,
	size = 54,
}: {
	done: boolean
	color: string
	size?: number
}) {
	return (
		<svg width={size} height={size} viewBox="0 0 54 54">
			<rect
				x={3}
				y={3}
				width={48}
				height={48}
				rx={14}
				fill={done ? color : 'none'}
				stroke={done ? color : colors.fieldBorder}
				strokeWidth={4}
			/>
			{done ? (
				<path
					d="M15 28l8 8 16-18"
					fill="none"
					stroke={colors.canvas}
					strokeWidth={6}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			) : null}
		</svg>
	)
}

/** A stand-in line of body text. */
export function TextLine({
	width,
	height = 22,
	color = colors.surfaceRaised,
	style,
}: {
	width: number | string
	height?: number
	color?: string
	style?: CSSProperties
}) {
	return (
		<div
			style={{
				width,
				height,
				borderRadius: height / 2,
				background: color,
				...style,
			}}
		/>
	)
}

export function Label({
	children,
	size = 32,
	muted = false,
	weight = 600,
	style,
}: {
	children: ReactNode
	size?: number
	muted?: boolean
	weight?: number
	style?: CSSProperties
}) {
	return (
		<div
			style={{
				fontSize: size,
				fontWeight: weight,
				color: muted ? colors.textMuted : colors.text,
				whiteSpace: 'nowrap',
				...style,
			}}
		>
			{children}
		</div>
	)
}

export function blink(age: number) {
	return Math.floor(age / 12) % 2 === 0 ? 1 : 0
}
