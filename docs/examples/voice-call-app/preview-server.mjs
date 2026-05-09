import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appSource = await readFile(join(here, 'app.ts'), 'utf8')
const match = appSource.match(/return `(?<html><!doctype html>[\s\S]*?)`\n}/)

if (!match?.groups?.html) {
	throw new Error('Could not extract preview HTML from app.ts.')
}

const previewHtml = match.groups.html.replace(
	'${statusText}',
	'Local preview harness: UI ready, Workers AI route intentionally returns setup guidance.',
)

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', 'http://127.0.0.1')
	if (url.pathname === '/api/status') {
		response.writeHead(200, {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json',
		})
		response.end(
			JSON.stringify({
				aiReady: false,
				voiceTransportReady: false,
				toolLoopReady: true,
			}),
		)
		return
	}
	if (url.pathname === '/api/chat') {
		const delayMs = Number.parseInt(
			process.env.PREVIEW_CHAT_DELAY_MS ?? '900',
			10,
		)
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		response.writeHead(503, {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json',
		})
		response.end(
			JSON.stringify({
				error:
					'Workers AI is not exposed to package apps yet. The UI is ready; connect env.AI to enable live model responses.',
			}),
		)
		return
	}
	response.writeHead(200, {
		'Cache-Control': 'no-store',
		'Content-Type': 'text/html; charset=utf-8',
	})
	response.end(previewHtml)
})

const port = Number.parseInt(process.env.PORT ?? '4173', 10)
server.listen(port, '127.0.0.1', () => {
	console.log(`Voice call app preview: http://127.0.0.1:${port}`)
})
