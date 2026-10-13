/* oxlint-disable no-undef -- browser module served from public/; the lint
   config's browser env does not apply here. */
// Opt-in "while you wait" Breakout over the live status page: the ball
// shatters the page's own words, status dots, and day bars. The
// server-rendered page works without this module. With it, this module owns
// the 60s auto-refresh (the <meta> refresh only runs inside <noscript>)
// because a meta refresh cannot be cancelled once a game starts.
import { createGame } from './status-breakout-game.js'

const refreshMs = 60_000
const brickZoneRatio = 0.58
const layoutWidthFactors = [1, 1.25, 1.5, 2, 2.5, 3, 4]

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const refreshTimer = setTimeout(() => location.reload(), refreshMs)

const pageMain = document.querySelector('main')
const startButton = document.querySelector('[data-breakout-start]')
if (
	pageMain instanceof HTMLElement &&
	startButton instanceof HTMLButtonElement
) {
	const forced = new URLSearchParams(location.search).has('play')
	if (forced || document.body.dataset.overallStatus !== 'operational') {
		startButton.hidden = false
		startButton.addEventListener(
			'click',
			() => void startGame(pageMain, startButton),
			{ once: true },
		)
	}
}

/**
 * @param {HTMLElement} main
 * @param {HTMLButtonElement} button
 */
async function startGame(main, button) {
	clearTimeout(refreshTimer)
	button.remove()
	wrapWords(main)
	const blocks = Array.from(main.children).filter(
		(child) => child instanceof HTMLElement,
	)
	const before = new Map(
		blocks.map((block) => [block, block.getBoundingClientRect()]),
	)
	scrollTo(0, 0)
	document.documentElement.classList.add('breakout-active')
	const scale = fitToPlayfield(main)
	if (!reducedMotion) await flyIn(blocks, before, scale)
	createGame(main, {
		scale,
		refit: () => fitToPlayfield(main),
		reducedMotion,
	})
}

/** Every word becomes its own brick. Whitespace stays as text so the page
 * keeps its exact line wrapping. @param {HTMLElement} root */
function wrapWords(root) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
	/** @type {Array<Text>} */
	const textNodes = []
	while (walker.nextNode()) {
		const node = /** @type {Text} */ (walker.currentNode)
		if (node.nodeValue?.trim()) textNodes.push(node)
	}
	for (const node of textNodes) {
		const fragment = document.createDocumentFragment()
		for (const part of (node.nodeValue ?? '').split(/(\s+)/)) {
			if (!part) continue
			if (/^\s+$/.test(part)) {
				fragment.append(part)
				continue
			}
			const word = document.createElement('span')
			word.className = 'brick-word'
			word.textContent = part
			fragment.append(word)
		}
		node.replaceWith(fragment)
	}
}

/**
 * Shrink the page so every brick sits in the top of the viewport and the
 * rest is open court for the ball. A wider grid has more columns and a
 * shorter wall, so try a few layout widths and keep whichever one can be
 * drawn largest.
 * @param {HTMLElement} main
 */
function fitToPlayfield(main) {
	main.style.transform = 'none'
	const zoneHeight = innerHeight * brickZoneRatio
	let best = { width: innerWidth, scale: 0 }
	for (const factor of layoutWidthFactors) {
		const width = Math.floor(innerWidth * factor)
		main.style.width = `${width}px`
		const height = main.getBoundingClientRect().height
		const scale = Math.min(zoneHeight / height, innerWidth / width, 1)
		if (scale > best.scale) best = { width, scale }
	}
	main.style.width = `${best.width}px`
	main.style.transform = `scale(${best.scale})`
	return best.scale
}

/**
 * FLIP each top-level block from where it sat in the reading layout into its
 * place in the brick wall.
 * @param {Array<HTMLElement>} blocks
 * @param {Map<HTMLElement, DOMRect>} before
 * @param {number} scale
 */
async function flyIn(blocks, before, scale) {
	const animations = blocks.map((block, index) => {
		const from = before.get(block)
		const to = block.getBoundingClientRect()
		if (!from || to.width === 0 || to.height === 0) return null
		const dx = (from.left - to.left) / scale
		const dy = (from.top - to.top) / scale
		const sx = from.width / to.width
		const sy = from.height / to.height
		return block.animate(
			[
				{
					transformOrigin: 'top left',
					transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
				},
				{ transformOrigin: 'top left', transform: 'none' },
			],
			{
				duration: 750,
				delay: index * 40,
				easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)',
			},
		)
	})
	await Promise.all(animations.map((animation) => animation?.finished))
}
