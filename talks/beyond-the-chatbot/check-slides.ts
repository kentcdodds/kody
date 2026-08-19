/**
 * Fit/fill check for the Ai Dev Craft reveal.js deck.
 *
 *   node talks/beyond-the-chatbot/check-slides.ts
 *   node talks/beyond-the-chatbot/check-slides.ts --screenshots .check-output
 */
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { isExecutedDirectly } from '../../tools/node-runtime.ts'
import {
	assessSlideLayout,
	type SlideLayoutMeasurement,
} from './slide-layout.ts'

declare global {
	interface Window {
		Reveal: {
			isReady: () => boolean
			getTotalSlides: () => number
			slide: (index: number) => void
			getIndices: () => { h: number }
		}
	}
}

const deckRoot = path.dirname(fileURLToPath(import.meta.url))
const siteRoot = path.join(deckRoot, 'site')
const viewport = { width: 1920, height: 1080 } as const
const mimeTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
}

type CollectedSlide = SlideLayoutMeasurement & {
	failures: ReturnType<typeof assessSlideLayout>['failures']
	widthRatio: number
	heightRatio: number
}

export async function checkDeckSlides(
	input: {
		screenshotDir?: string
		colorScheme?: 'light' | 'dark'
	} = {},
) {
	const server = await listenForSite()
	const browser = await launchBrowser()
	const page = await browser.newPage({
		viewport,
		deviceScaleFactor: 1,
		colorScheme: input.colorScheme ?? 'light',
	})

	try {
		await page.goto(server.url, { waitUntil: 'networkidle' })
		await page.waitForFunction(() => Boolean(window.Reveal?.isReady?.()))
		await page.evaluate(() => document.fonts.ready)

		const slideCount = await page.evaluate(() => window.Reveal.getTotalSlides())

		if (input.screenshotDir) {
			await mkdir(input.screenshotDir, { recursive: true })
		}

		const slides: Array<CollectedSlide> = []
		for (let index = 0; index < slideCount; index += 1) {
			await page.evaluate((slideIndex) => {
				window.Reveal.slide(slideIndex)
			}, index)
			await page.waitForFunction((slideIndex) => {
				return window.Reveal.getIndices().h === slideIndex
			}, index)
			await page.evaluate(
				() =>
					new Promise((resolve) => {
						requestAnimationFrame(() => requestAnimationFrame(resolve))
					}),
			)

			const measurement = (await page.evaluate((slideIndex) => {
				function toBox(rect) {
					return {
						left: rect.left,
						top: rect.top,
						right: rect.right,
						bottom: rect.bottom,
					}
				}

				const section = document.querySelector(
					'.reveal .slides section.present',
				)
				const footer = document.querySelector('.deck-footer')
				if (
					!(section instanceof HTMLElement) ||
					!(footer instanceof HTMLElement)
				) {
					throw new Error('Deck slide or footer is missing')
				}

				const body = section.querySelector('.slide-body')
				if (!(body instanceof HTMLElement)) {
					throw new Error('Slide is missing .slide-body')
				}

				const slide = toBox(section.getBoundingClientRect())
				const footerTop = footer.getBoundingClientRect().top
				const limitBottom = Math.min(slide.bottom, footerTop)
				let overflowPx = 0
				const nodes = [body, ...body.querySelectorAll('*')]
				for (const node of nodes) {
					if (!(node instanceof HTMLElement)) {
						continue
					}
					const style = getComputedStyle(node)
					if (style.display === 'none' || style.visibility === 'hidden') {
						continue
					}
					const rect = node.getBoundingClientRect()
					if (rect.width < 1 || rect.height < 1) {
						continue
					}
					overflowPx = Math.max(
						overflowPx,
						slide.left - rect.left,
						rect.right - slide.right,
						slide.top - rect.top,
						rect.bottom - limitBottom,
					)
				}

				const childBoxes = Array.from(body.children).flatMap((node) => {
					if (!(node instanceof HTMLElement)) {
						return []
					}
					const rect = node.getBoundingClientRect()
					if (rect.width < 1 || rect.height < 1) {
						return []
					}
					return [toBox(rect)]
				})
				const content =
					childBoxes.length === 0
						? null
						: {
								left: Math.min(...childBoxes.map((box) => box.left)),
								top: Math.min(...childBoxes.map((box) => box.top)),
								right: Math.max(...childBoxes.map((box) => box.right)),
								bottom: Math.max(...childBoxes.map((box) => box.bottom)),
							}

				const heading = body.querySelector('h1, h2, h3')
				const title =
					heading?.textContent?.replace(/\s+/g, ' ').trim() ||
					`Slide ${slideIndex + 1}`

				return {
					index: slideIndex,
					title,
					slide,
					footerTop,
					content,
					overflowPx,
				}
			}, index)) as SlideLayoutMeasurement

			const assessment = assessSlideLayout(measurement)
			slides.push({
				...measurement,
				failures: assessment.failures,
				widthRatio: assessment.widthRatio,
				heightRatio: assessment.heightRatio,
			})

			if (input.screenshotDir) {
				const slug = String(index + 1).padStart(2, '0')
				await page.screenshot({
					path: path.join(input.screenshotDir, `slide-${slug}.png`),
					type: 'png',
				})
			}
		}

		return { url: server.url, slides }
	} finally {
		await page.close()
		await browser.close()
		await server.close()
	}
}

function formatPct(ratio: number) {
	return `${Math.round(ratio * 100)}%`
}

function printReport(slides: ReadonlyArray<CollectedSlide>) {
	const rows = slides.map((slide) => {
		const status = slide.failures.length === 0 ? 'ok' : 'FAIL'
		return {
			n: String(slide.index + 1).padStart(2, ' '),
			status,
			w: formatPct(slide.widthRatio).padStart(4, ' '),
			h: formatPct(slide.heightRatio).padStart(4, ' '),
			overflow: `${Math.max(0, Math.round(slide.overflowPx * 10) / 10)}px`,
			title: slide.title,
			failures: slide.failures,
		}
	})

	console.log('n  status  width height overflow  title')
	for (const row of rows) {
		console.log(
			`${row.n}  ${row.status.padEnd(5, ' ')}  ${row.w}  ${row.h}  ${row.overflow.padStart(8, ' ')}  ${row.title}`,
		)
		for (const failure of row.failures) {
			console.log(`       - ${failure.message}`)
		}
	}
}

async function listenForSite() {
	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const relativePath =
			url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)
		const filePath = path.resolve(
			siteRoot,
			`.${path.posix.normalize(`/${relativePath}`)}`,
		)
		if (!filePath.startsWith(siteRoot) || !existsSync(filePath)) {
			response.writeHead(404)
			response.end('Not found')
			return
		}
		const contentType =
			mimeTypes[path.extname(filePath)] ?? 'application/octet-stream'
		response.writeHead(200, { 'Content-Type': contentType })
		createReadStream(filePath).pipe(response)
	})

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Deck static server did not bind a port')
	}

	return {
		url: `http://127.0.0.1:${address.port}/`,
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
		},
	}
}

async function launchBrowser() {
	const executablePath = resolveBrowserExecutable()
	return chromium.launch({
		executablePath,
		args: ['--no-sandbox', '--disable-gpu'],
	})
}

function resolveBrowserExecutable() {
	const playwrightPath = chromium.executablePath()
	if (existsSync(playwrightPath)) {
		return playwrightPath
	}
	if (existsSync('/usr/bin/google-chrome-stable')) {
		return '/usr/bin/google-chrome-stable'
	}
	throw new Error(
		'No Chromium/Chrome executable found. Run `npm run test:e2e:ensure` or install Chrome.',
	)
}

async function main() {
	const screenshotFlag = process.argv.find((argument) =>
		argument.startsWith('--screenshots'),
	)
	let screenshotDir: string | undefined
	if (screenshotFlag === '--screenshots') {
		const flagIndex = process.argv.indexOf('--screenshots')
		screenshotDir =
			process.argv[flagIndex + 1] ?? path.join(deckRoot, '.check-output')
	} else if (screenshotFlag?.startsWith('--screenshots=')) {
		screenshotDir = screenshotFlag.slice('--screenshots='.length)
	}

	const colorSchemeFlag = process.argv.find((argument) =>
		argument.startsWith('--color-scheme'),
	)
	let colorScheme: 'light' | 'dark' | undefined
	if (colorSchemeFlag === '--color-scheme') {
		const flagIndex = process.argv.indexOf('--color-scheme')
		const value = process.argv[flagIndex + 1]
		if (value === 'light' || value === 'dark') {
			colorScheme = value
		}
	} else if (colorSchemeFlag?.startsWith('--color-scheme=')) {
		const value = colorSchemeFlag.slice('--color-scheme='.length)
		if (value === 'light' || value === 'dark') {
			colorScheme = value
		}
	}

	const result = await checkDeckSlides({ screenshotDir, colorScheme })
	printReport(result.slides)

	const failed = result.slides.filter((slide) => slide.failures.length > 0)
	if (screenshotDir) {
		await writeFile(
			path.join(screenshotDir, 'report.json'),
			`${JSON.stringify(result.slides, null, 2)}\n`,
		)
		console.log(`Wrote screenshots to ${screenshotDir}`)
	}

	if (failed.length > 0) {
		console.error(
			`\n${failed.length} of ${result.slides.length} slides failed the fit/fill check.`,
		)
		process.exitCode = 1
		return
	}

	console.log(`\nAll ${result.slides.length} slides fit and fill the frame.`)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
