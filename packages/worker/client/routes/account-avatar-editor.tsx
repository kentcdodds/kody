import { css, ref, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	clampTransform,
	coverScale,
	cropRectFromTransform,
	initialCoverTransform,
	maxScale,
	panBy,
	resizeTransform,
	zoomAtPoint,
	type AvatarCropBounds,
	type AvatarCropTransform,
} from '#client/avatar-crop.ts'
import {
	decodeAvatarImage,
	prepareDecodedAvatarImage,
	scaleToMaxDimension,
	type AvatarImageBitmap,
} from '#client/prepare-avatar-image.ts'
import {
	userAvatarMaxDimension,
	userAvatarMinDimension,
} from '#universal/user-avatar-limits.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	mergeCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { accountFieldNoteCss } from '#client/routes/account-management-components.tsx'

const previewMaxDimension = 1600
const zoomStep = 1.15
const panStep = 16

type EditorStatus = 'idle' | 'decoding' | 'ready' | 'applying'

export function AccountAvatarEditor(
	handle: Handle<{
		file: File | null
		onCancel: () => void
		onApply: (prepared: File) => void
		onBusyChange: (busy: boolean) => void
	}>,
) {
	let dialogNode: HTMLDialogElement | null = null
	let stageNode: HTMLElement | null = null
	let imageNode: HTMLImageElement | null = null
	let zoomInputNode: HTMLInputElement | null = null
	let status: EditorStatus = 'idle'
	let error: string | null = null
	let bitmap: AvatarImageBitmap | null = null
	let previewUrl: string | null = null
	let viewportSize = 280
	let transform: AvatarCropTransform = { scale: 1, offsetX: 0, offsetY: 0 }
	let activeFile: File | null = null
	let loadGeneration = 0

	function currentBounds(): AvatarCropBounds | null {
		if (!bitmap) return null
		return {
			imageWidth: bitmap.width,
			imageHeight: bitmap.height,
			viewportSize,
		}
	}

	function releasePreview() {
		if (previewUrl) URL.revokeObjectURL(previewUrl)
		previewUrl = null
	}

	function releaseBitmap() {
		bitmap?.close?.()
		bitmap = null
		releasePreview()
	}

	function applyVisuals() {
		const bounds = currentBounds()
		if (!imageNode || !bounds) return
		imageNode.style.width = `${bounds.imageWidth * transform.scale}px`
		imageNode.style.height = `${bounds.imageHeight * transform.scale}px`
		imageNode.style.transform = `translate(${transform.offsetX}px, ${transform.offsetY}px)`
		if (zoomInputNode) {
			zoomInputNode.value = String(transform.scale)
		}
	}

	function setTransform(next: AvatarCropTransform) {
		const bounds = currentBounds()
		const previousScale = transform.scale
		transform = bounds ? clampTransform(bounds, next) : next
		applyVisuals()
		// Wheel and pinch update the image immediately. Remix still owns the
		// slider `value` and zoom-button disabled state, so a scale change
		// without `handle.update()` leaves those controls on the last render.
		if (Math.abs(transform.scale - previousScale) > 0.0001) {
			handle.update()
		}
	}

	function zoomFromCenter(nextScale: number) {
		const bounds = currentBounds()
		if (!bounds) return
		setTransform(
			zoomAtPoint(
				bounds,
				transform,
				nextScale,
				bounds.viewportSize / 2,
				bounds.viewportSize / 2,
			),
		)
	}

	function unlockScroll() {
		if (typeof document === 'undefined') return
		document.body.style.overflow = ''
	}

	function lockScroll() {
		if (typeof document === 'undefined') return
		document.body.style.overflow = 'hidden'
	}

	function closeEditor() {
		loadGeneration += 1
		releaseBitmap()
		status = 'idle'
		error = null
		activeFile = null
		unlockScroll()
		dialogNode?.close()
		handle.props.onCancel()
	}

	async function applyCrop() {
		const file = handle.props.file
		const bounds = currentBounds()
		if (!file || !bitmap || !bounds || status !== 'ready') return
		status = 'applying'
		error = null
		handle.props.onBusyChange(true)
		handle.update()
		try {
			const prepared = await prepareDecodedAvatarImage(
				file,
				bitmap,
				undefined,
				cropRectFromTransform(bounds, transform),
			)
			releaseBitmap()
			status = 'idle'
			activeFile = null
			unlockScroll()
			dialogNode?.close()
			handle.props.onApply(prepared)
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to prepare that avatar.'
			status = 'ready'
			handle.props.onBusyChange(false)
			handle.update()
		}
	}

	function startLoad(file: File | null) {
		const generation = ++loadGeneration
		void (async () => {
			releaseBitmap()
			error = null
			if (!file) {
				unlockScroll()
				dialogNode?.close()
				if (generation !== loadGeneration) return
				status = 'idle'
				handle.update()
				return
			}
			lockScroll()
			dialogNode?.showModal()
			try {
				const nextBitmap = await decodeAvatarImage(file)
				if (generation !== loadGeneration) {
					nextBitmap.close?.()
					return
				}
				if (
					nextBitmap.width < userAvatarMinDimension ||
					nextBitmap.height < userAvatarMinDimension
				) {
					nextBitmap.close?.()
					throw new Error(
						`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
					)
				}
				bitmap = nextBitmap
				previewUrl = await createPreviewObjectUrl(nextBitmap, file)
				if (generation !== loadGeneration) {
					releaseBitmap()
					return
				}
				const measured = stageNode?.clientWidth
				if (measured && measured > 0) viewportSize = measured
				transform = initialCoverTransform({
					imageWidth: nextBitmap.width,
					imageHeight: nextBitmap.height,
					viewportSize,
				})
				status = 'ready'
			} catch (caught) {
				if (generation !== loadGeneration) return
				releaseBitmap()
				error =
					caught instanceof Error
						? caught.message
						: 'Could not read that image in the browser.'
				status = 'idle'
			}
			handle.update()
		})()
	}

	function attachStage(node: HTMLElement, signal: AbortSignal) {
		stageNode = node
		const pointers = new Map<number, { x: number; y: number }>()
		let pinchDistance = 0
		let lastX = 0
		let lastY = 0

		const observer = new ResizeObserver(() => {
			const nextSize = node.clientWidth
			const bounds = currentBounds()
			if (!bounds || nextSize <= 0 || nextSize === viewportSize) return
			transform = resizeTransform(
				bounds,
				{ ...bounds, viewportSize: nextSize },
				transform,
			)
			viewportSize = nextSize
			applyVisuals()
		})
		observer.observe(node)

		function handlePointerDown(event: PointerEvent) {
			if (event.button !== 0) return
			event.preventDefault()
			node.setPointerCapture(event.pointerId)
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
			lastX = event.clientX
			lastY = event.clientY
			if (pointers.size === 2) {
				const [first, second] = Array.from(pointers.values())
				if (!first || !second) return
				pinchDistance = Math.hypot(first.x - second.x, first.y - second.y)
			}
		}

		function handlePointerMove(event: PointerEvent) {
			if (!pointers.has(event.pointerId)) return
			event.preventDefault()
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
			const bounds = currentBounds()
			if (!bounds) return
			if (pointers.size >= 2) {
				const [first, second] = Array.from(pointers.values())
				if (!first || !second || pinchDistance <= 0) return
				const nextDistance = Math.hypot(first.x - second.x, first.y - second.y)
				const midpoint = {
					x: (first.x + second.x) / 2,
					y: (first.y + second.y) / 2,
				}
				const rect = node.getBoundingClientRect()
				setTransform(
					zoomAtPoint(
						bounds,
						transform,
						transform.scale * (nextDistance / pinchDistance),
						midpoint.x - rect.left,
						midpoint.y - rect.top,
					),
				)
				pinchDistance = nextDistance
				return
			}
			setTransform(
				panBy(bounds, transform, event.clientX - lastX, event.clientY - lastY),
			)
			lastX = event.clientX
			lastY = event.clientY
		}

		function handlePointerUp(event: PointerEvent) {
			if (!pointers.has(event.pointerId)) return
			pointers.delete(event.pointerId)
			if (pointers.size === 1) {
				const remaining = Array.from(pointers.values())[0]
				if (remaining) {
					lastX = remaining.x
					lastY = remaining.y
				}
				pinchDistance = 0
			}
			if (pointers.size === 0) handle.update()
		}

		function handleWheel(event: WheelEvent) {
			event.preventDefault()
			const bounds = currentBounds()
			if (!bounds) return
			const point = {
				x: event.clientX - node.getBoundingClientRect().left,
				y: event.clientY - node.getBoundingClientRect().top,
			}
			setTransform(
				zoomAtPoint(
					bounds,
					transform,
					transform.scale * Math.exp(-event.deltaY * 0.002),
					point.x,
					point.y,
				),
			)
		}

		node.addEventListener('pointerdown', handlePointerDown)
		node.addEventListener('pointermove', handlePointerMove)
		node.addEventListener('pointerup', handlePointerUp)
		node.addEventListener('pointercancel', handlePointerUp)
		node.addEventListener('wheel', handleWheel, { passive: false })
		signal.addEventListener('abort', () => {
			observer.disconnect()
			node.removeEventListener('pointerdown', handlePointerDown)
			node.removeEventListener('pointermove', handlePointerMove)
			node.removeEventListener('pointerup', handlePointerUp)
			node.removeEventListener('pointercancel', handlePointerUp)
			node.removeEventListener('wheel', handleWheel)
			if (stageNode === node) stageNode = null
		})
		const measured = node.clientWidth
		const bounds = currentBounds()
		if (measured > 0 && bounds && measured !== viewportSize) {
			transform = resizeTransform(
				bounds,
				{ ...bounds, viewportSize: measured },
				transform,
			)
			viewportSize = measured
		}
		applyVisuals()
	}

	handle.signal.addEventListener(
		'abort',
		() => {
			loadGeneration += 1
			releaseBitmap()
			unlockScroll()
		},
		{ once: true },
	)

	return () => {
		const file = handle.props.file
		if (file !== activeFile && status !== 'applying') {
			activeFile = file
			status = file ? 'decoding' : 'idle'
			error = file ? null : error
			handle.queueTask(() => {
				startLoad(file)
			})
		}

		const bounds = currentBounds()
		const cover = bounds ? coverScale(bounds) : 1
		const zoomMax = bounds ? maxScale(bounds) : 1
		const canZoom = zoomMax - cover > 0.001
		const busy = status === 'decoding' || status === 'applying'
		const canApply = status === 'ready' && Boolean(bitmap) && !error

		return (
			<dialog
				aria-labelledby="avatar-editor-title"
				data-testid="account-avatar-editor"
				mix={[
					css(editorDialogCss),
					ref((node, signal) => {
						if (!(node instanceof HTMLDialogElement)) return
						dialogNode = node
						if (handle.props.file && !node.open) node.showModal()
						signal.addEventListener('abort', () => {
							if (dialogNode === node) dialogNode = null
						})
					}),
					on('cancel', (event) => {
						event.preventDefault()
						if (status === 'applying') return
						closeEditor()
					}),
					on('keydown', (event) => {
						if (!(event instanceof KeyboardEvent) || status !== 'ready') return
						if (
							event.target === zoomInputNode ||
							(event.target instanceof HTMLInputElement &&
								event.target.type === 'range')
						) {
							return
						}
						const key = event.key
						if (key === 'ArrowLeft') {
							event.preventDefault()
							const next = currentBounds()
							if (next) setTransform(panBy(next, transform, panStep, 0))
							return
						}
						if (key === 'ArrowRight') {
							event.preventDefault()
							const next = currentBounds()
							if (next) setTransform(panBy(next, transform, -panStep, 0))
							return
						}
						if (key === 'ArrowUp') {
							event.preventDefault()
							const next = currentBounds()
							if (next) setTransform(panBy(next, transform, 0, panStep))
							return
						}
						if (key === 'ArrowDown') {
							event.preventDefault()
							const next = currentBounds()
							if (next) setTransform(panBy(next, transform, 0, -panStep))
							return
						}
						if (key === '+' || key === '=') {
							event.preventDefault()
							zoomFromCenter(transform.scale * zoomStep)
							return
						}
						if (key === '-' || key === '_') {
							event.preventDefault()
							zoomFromCenter(transform.scale / zoomStep)
						}
					}),
				]}
			>
				<div mix={css(editorShellCss)}>
					<div mix={css(editorCopyCss)}>
						<h3 id="avatar-editor-title" mix={css(editorTitleCss)}>
							Crop your avatar
						</h3>
						<p mix={css(accountFieldNoteCss)}>
							Drag to reposition. Pinch, scroll, or use the slider to zoom. The
							circle is how your avatar will look.
						</p>
					</div>
					{status === 'decoding' ? (
						<p mix={css(accountFieldNoteCss)}>Reading photo…</p>
					) : null}
					{status === 'ready' && previewUrl ? (
						<div
							data-testid="account-avatar-editor-stage"
							role="img"
							aria-label="Avatar crop preview"
							mix={[
								css(editorStageCss),
								ref((node, signal) => {
									if (!(node instanceof HTMLElement)) return
									attachStage(node, signal)
								}),
							]}
						>
							<img
								src={previewUrl}
								alt=""
								draggable={false}
								mix={[
									css(editorImageCss),
									ref((node) => {
										if (!(node instanceof HTMLImageElement)) return
										imageNode = node
										applyVisuals()
									}),
								]}
							/>
							<div mix={css(editorCircleMaskCss)} />
						</div>
					) : null}
					{status === 'ready' ? (
						<div mix={css(editorZoomRowCss)}>
							<button
								type="button"
								aria-label="Zoom out"
								disabled={!canZoom || transform.scale <= cover}
								mix={[
									css(editorZoomButtonCss),
									on('click', () => {
										zoomFromCenter(transform.scale / zoomStep)
										handle.update()
									}),
								]}
							>
								−
							</button>
							<input
								type="range"
								min={cover}
								max={zoomMax}
								step="any"
								value={transform.scale}
								disabled={!canZoom}
								aria-label="Zoom"
								data-testid="account-avatar-editor-zoom"
								mix={[
									css(editorZoomSliderCss),
									ref((node) => {
										zoomInputNode =
											node instanceof HTMLInputElement ? node : null
									}),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement)) {
											return
										}
										zoomFromCenter(Number(event.currentTarget.value))
									}),
								]}
							/>
							<button
								type="button"
								aria-label="Zoom in"
								disabled={!canZoom || transform.scale >= zoomMax}
								mix={[
									css(editorZoomButtonCss),
									on('click', () => {
										zoomFromCenter(transform.scale * zoomStep)
										handle.update()
									}),
								]}
							>
								+
							</button>
						</div>
					) : null}
					{error ? (
						<p
							role="alert"
							mix={css({
								margin: 0,
								color: colors.error,
								fontSize: typography.fontSize.sm,
							})}
						>
							{error}
						</p>
					) : null}
					<div mix={css(editorActionsCss)}>
						<button
							type="button"
							disabled={status === 'applying'}
							data-testid="account-avatar-editor-cancel"
							mix={[
								css(editorGhostButtonCss),
								on('click', () => {
									if (status === 'applying') return
									closeEditor()
								}),
							]}
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={!canApply || busy}
							data-testid="account-avatar-editor-apply"
							mix={[
								css(editorApplyButtonCss),
								on('click', () => {
									void applyCrop()
								}),
							]}
						>
							{status === 'applying' ? 'Preparing…' : 'Use photo'}
						</button>
					</div>
				</div>
			</dialog>
		)
	}
}

async function createPreviewObjectUrl(
	bitmap: AvatarImageBitmap,
	file: File,
): Promise<string> {
	try {
		const scaled = scaleToMaxDimension(
			bitmap.width,
			bitmap.height,
			previewMaxDimension,
		)
		const canvas = document.createElement('canvas')
		canvas.width = scaled.width
		canvas.height = scaled.height
		const context = canvas.getContext('2d')
		if (!context)
			throw new Error('Unable to convert that image in the browser.')
		context.drawImage(
			bitmap as CanvasImageSource,
			0,
			0,
			bitmap.width,
			bitmap.height,
			0,
			0,
			scaled.width,
			scaled.height,
		)
		const blob = await new Promise<Blob | null>((resolve, reject) => {
			try {
				canvas.toBlob(resolve, 'image/jpeg', 0.82)
			} catch (caught) {
				reject(caught)
			}
		})
		if (!blob) throw new Error('Unable to convert that image in the browser.')
		return URL.createObjectURL(blob)
	} catch {
		return URL.createObjectURL(file)
	}
}

const editorDialogCss = {
	width: 'min(28rem, calc(100vw - 1.5rem))',
	maxWidth: '100vw',
	maxHeight: '100dvh',
	margin: 'auto',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	overflow: 'auto',
	overscrollBehavior: 'contain',
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.55)',
	},
	[mq.mobile]: {
		width: '100vw',
		height: '100dvh',
		maxHeight: '100dvh',
		margin: 0,
		border: 'none',
		borderRadius: 0,
	},
}

const editorShellCss = {
	display: 'grid',
	gap: spacing.md,
	minHeight: 0,
	padding: spacing.lg,
	paddingBottom: `max(${spacing.lg}, env(safe-area-inset-bottom))`,
	paddingLeft: `max(${spacing.md}, env(safe-area-inset-left))`,
	paddingRight: `max(${spacing.md}, env(safe-area-inset-right))`,
	[mq.mobile]: {
		minHeight: '100dvh',
		gridTemplateRows: 'auto auto 1fr auto auto',
		alignContent: 'start',
	},
}

const editorCopyCss = {
	display: 'grid',
	gap: spacing.sm,
}

const editorTitleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

const editorStageCss = {
	position: 'relative' as const,
	width: 'min(22rem, 100%)',
	aspectRatio: '1',
	marginInline: 'auto',
	overflow: 'hidden',
	borderRadius: radius.md,
	backgroundColor: colors.background,
	touchAction: 'none',
	cursor: 'grab',
	userSelect: 'none',
	outline: 'none',
	'&:focus-visible': {
		boxShadow: `0 0 0 3px ${colors.primarySoft}`,
	},
	[mq.mobile]: {
		width: 'min(22rem, calc(100vw - 2rem))',
		maxHeight: 'min(22rem, calc(100dvh - 16rem))',
	},
}

const editorImageCss = {
	position: 'absolute' as const,
	top: 0,
	left: 0,
	maxWidth: 'none',
	maxHeight: 'none',
	pointerEvents: 'none',
	userSelect: 'none',
}

const editorCircleMaskCss = {
	position: 'absolute' as const,
	inset: 0,
	borderRadius: '50%',
	border: `2px solid ${colors.onPrimary}`,
	boxShadow: `0 0 0 999px color-mix(in srgb, ${colors.background} 58%, transparent)`,
	pointerEvents: 'none',
}

const editorZoomRowCss = {
	display: 'grid',
	gridTemplateColumns: 'auto 1fr auto',
	alignItems: 'center',
	gap: spacing.sm,
}

const editorZoomButtonCss = mergeCss(getGhostButtonCss({ size: 'sm' }), {
	minWidth: '2.75rem',
	minHeight: '2.75rem',
	padding: 0,
	fontSize: '1.25rem',
	lineHeight: 1,
	touchAction: 'manipulation',
})

const editorZoomSliderCss = {
	width: '100%',
	height: '2.75rem',
	margin: 0,
	accentColor: colors.primary,
	touchAction: 'none',
	'&::-webkit-slider-thumb': {
		width: '1.5rem',
		height: '1.5rem',
	},
	'&::-moz-range-thumb': {
		width: '1.5rem',
		height: '1.5rem',
	},
}

const editorActionsCss = {
	display: 'flex',
	justifyContent: 'flex-end',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	[mq.mobile]: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		position: 'sticky' as const,
		bottom: 0,
		paddingTop: spacing.sm,
		backgroundColor: colors.surface,
	},
}

const editorGhostButtonCss = mergeCss(getGhostButtonCss({ size: 'sm' }), {
	touchAction: 'manipulation',
	[mq.mobile]: {
		minHeight: '2.75rem',
		width: '100%',
	},
})

const editorApplyButtonCss = mergeCss(getPillButtonCss({ size: 'sm' }), {
	touchAction: 'manipulation',
	[mq.mobile]: {
		minHeight: '2.75rem',
		width: '100%',
	},
})
