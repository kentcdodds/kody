import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const artifactDir = resolve(
	process.env.VOICE_APP_ARTIFACT_DIR ?? '/tmp/kody-voice-app-self-test',
)

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}

async function getFreePort() {
	return await new Promise((resolvePort, reject) => {
		const server = net.createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : null
			server.close(() => {
				if (port == null) reject(new Error('Could not allocate a free port.'))
				else resolvePort(port)
			})
		})
	})
}

async function waitForStatus(url) {
	const deadline = Date.now() + 10_000
	let lastError
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/status`)
			if (response.ok) return
		} catch (error) {
			lastError = error
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
	}
	throw new Error(`Preview server did not become ready: ${lastError}`)
}

async function startPreviewServer(port) {
	const child = spawn(
		process.execPath,
		['docs/examples/voice-call-app/preview-server.mjs'],
		{
			cwd: resolve(here, '../../..'),
			env: {
				...process.env,
				PORT: String(port),
				PREVIEW_CHAT_DELAY_MS: '1400',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	)
	child.stdout.on('data', (chunk) => process.stdout.write(chunk))
	child.stderr.on('data', (chunk) => process.stderr.write(chunk))
	child.once('exit', (code, signal) => {
		if (code != null && code !== 0) {
			console.error(`Preview server exited with code ${code}.`)
		}
		if (signal) {
			console.error(`Preview server exited from signal ${signal}.`)
		}
	})
	await waitForStatus(`http://127.0.0.1:${port}`)
	return child
}

async function runDesktopFlow(page, baseUrl) {
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.goto(baseUrl)

	await page.getByRole('heading', { name: 'Kody Voice' }).waitFor()
	await page.getByRole('button', { name: 'Start call' }).click()
	await page.getByText('Listening mode ready').waitFor()
	await assertText(
		page.locator('#status-pill'),
		'listening',
		'Expected listening state.',
	)
	const utterance = page.getByLabel('Utterance')
	await assertEnabled(utterance, 'Expected utterance field to be enabled.')
	assert(
		await utterance.evaluate((element) => element === document.activeElement),
		'Expected utterance field to receive focus after starting the call.',
	)

	await utterance.fill('What Kody tools can you use?')
	await page.getByRole('button', { name: 'Send utterance' }).click()
	await page.getByText('Kody is thinking. Pending sound is playing.').waitFor()
	await assertText(
		page.locator('#status-pill'),
		'thinking',
		'Expected thinking state.',
	)
	await page.screenshot({
		path: resolve(artifactDir, 'voice-app-thinking.png'),
		fullPage: true,
	})

	await page
		.locator('#error')
		.getByText('Workers AI is not exposed to package apps yet')
		.waitFor()
	await assertText(
		page.locator('#status-pill'),
		'listening',
		'Expected return to listening after setup guidance.',
	)
	await page.getByRole('button', { name: 'Toggle theme' }).click()
	await page.waitForFunction(
		() => document.documentElement.dataset.theme === 'dark',
	)
	await page.screenshot({
		path: resolve(artifactDir, 'voice-app-dark-result.png'),
		fullPage: true,
	})
}

async function runMobileLayoutCheck(page, baseUrl) {
	await page.setViewportSize({ width: 390, height: 780 })
	await page.goto(baseUrl)
	await page.getByRole('heading', { name: 'Kody Voice' }).waitFor()
	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth + 1,
	)
	assert(
		!hasHorizontalOverflow,
		'Expected mobile layout without horizontal overflow.',
	)
	const heroGridColumns = await page.locator('.hero').evaluate((element) => {
		return getComputedStyle(element).gridTemplateColumns.split(' ').length
	})
	assert(
		heroGridColumns === 1,
		'Expected mobile layout to collapse to one column.',
	)
	await page.screenshot({
		path: resolve(artifactDir, 'voice-app-mobile.png'),
		fullPage: true,
	})
}

async function assertText(locator, expected, message) {
	const text = (await locator.textContent())?.trim().toLowerCase()
	assert(text === expected, `${message} Saw "${text}".`)
}

async function assertEnabled(locator, message) {
	assert(!(await locator.isDisabled()), message)
}

async function main() {
	await mkdir(artifactDir, { recursive: true })
	const port = await getFreePort()
	const baseUrl = `http://127.0.0.1:${port}`
	const server = await startPreviewServer(port)
	const browser = await chromium.launch({
		headless: process.env.HEADLESS !== 'false',
	})
	try {
		const page = await browser.newPage()
		await runDesktopFlow(page, baseUrl)
		await runMobileLayoutCheck(page, baseUrl)
		console.log('Voice app self-test passed.')
		console.log(`Screenshots written to ${artifactDir}`)
	} finally {
		await browser.close()
		server.kill('SIGTERM')
	}
}

await main()
