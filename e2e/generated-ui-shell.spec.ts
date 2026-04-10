import { expect, test } from '@playwright/test'

function escapeHtmlScriptContent(value: string) {
	return value.replaceAll('</script>', '<\\/script>')
}

test('generated UI shell rerenders inline and saved apps without document rewrites', async ({
	page,
	baseURL,
}) => {
	if (!baseURL) {
		throw new Error(
			'Playwright baseURL is required for generated UI shell tests.',
		)
	}

	const runtimeUrl = new URL('/dev/generated-ui', baseURL).toString()
	const inlineHtml = [
		'<main id="inline-app"></main>',
		'<script>',
		"const btn = document.createElement('button')",
		"btn.id = 'first-inline-button'",
		"btn.textContent = 'First inline button'",
		"document.querySelector('#inline-app')?.append(btn)",
		'</script>',
		'<script>',
		"const btn = document.createElement('button')",
		"btn.id = 'second-inline-button'",
		"btn.textContent = 'Second inline button'",
		"document.querySelector('#inline-app')?.append(btn)",
		'window.kodyWidget.executeCode(\'async () => ({ phase: "inline", owner: window.kodyWidget.params.owner })\').then((result) => {',
		'\tdocument.body.dataset.inlineExecute = JSON.stringify(result)',
		'})',
		'</script>',
	].join('\n')
	const savedHtml = [
		'<!doctype html>',
		'<html lang="en" data-shell-phase="saved">',
		'<head>',
		'<title>Saved app</title>',
		'<style>body { font-family: system-ui, sans-serif; }</style>',
		'</head>',
		'<body data-shell-body="saved">',
		'<main id="saved-app"><button id="saved-app-button">Saved app</button></main>',
		'<script type="module">',
		'const result = await window.kodyWidget.executeCode(\'async () => ({ phase: "saved", owner: window.kodyWidget.params.owner })\')',
		'window.document.body.dataset.savedExecute = JSON.stringify(result)',
		'window.document.body.dataset.savedParams = JSON.stringify(window.kodyWidget.params)',
		"window.document.documentElement.dataset.savedHtmlAttr = window.document.documentElement.getAttribute('data-shell-phase') ?? 'missing'",
		'</script>',
		'</body>',
		'</html>',
	].join('\n')
	const inlineHtmlJson = escapeHtmlScriptContent(JSON.stringify(inlineHtml))
	const savedHtmlJson = escapeHtmlScriptContent(JSON.stringify(savedHtml))

	await page.setContent(`
		<!doctype html>
		<html lang="en">
			<body>
				<iframe
					id="generated-ui-frame"
					src=${JSON.stringify(runtimeUrl)}
					style="width: 960px; height: 720px; border: 0;"
				></iframe>
				<script>
					const frame = document.getElementById('generated-ui-frame')
					const hostState = {
						renderData: undefined,
						lastSize: null,
						toolCalls: [],
						savedSource: {
							code: ${savedHtmlJson},
							runtime: 'html',
						},
					}
					window.__generatedUiHostState = hostState
					function postToFrame(message) {
						frame.contentWindow?.postMessage(message, '*')
					}
					function postRenderData() {
						postToFrame({
							type: 'ui-lifecycle-iframe-render-data',
							payload: {
								renderData: hostState.renderData,
							},
						})
					}
					window.__generatedUiHostActions = {
						renderInline(params) {
							hostState.renderData = {
								toolOutput: {
									renderSource: 'inline_code',
									code: ${inlineHtmlJson},
									runtime: 'html',
									params,
								},
							}
							postRenderData()
						},
						renderSaved(params) {
							hostState.renderData = {
								toolOutput: {
									renderSource: 'saved_app',
									appId: 'saved-app-123',
									params,
								},
							}
							postRenderData()
						},
					}
					window.addEventListener('message', (event) => {
						if (event.source !== frame.contentWindow) {
							return
						}
						const message = event.data
						if (!message || typeof message !== 'object') {
							return
						}
						if (message.type === 'ui-request-render-data') {
							postRenderData()
							return
						}
						if (message.jsonrpc === '2.0' && message.method === 'ui/initialize') {
							postToFrame({
								jsonrpc: '2.0',
								id: message.id,
								result: {
									protocolVersion: '2026-01-26',
									hostInfo: {
										name: 'playwright-shell-host',
										version: '1.0.0',
									},
									hostCapabilities: {
										message: { text: {} },
										serverTools: {},
									},
									hostContext: hostState.renderData ?? {},
								},
							})
							return
						}
						if (
							message.jsonrpc === '2.0' &&
							message.method === 'ui/notifications/size-changed'
						) {
							hostState.lastSize = message.params ?? null
							return
						}
						if (message.jsonrpc === '2.0' && message.method === 'tools/call') {
							hostState.toolCalls.push(message.params ?? {})
							if (message.params?.name === 'ui_load_app_source') {
								postToFrame({
									jsonrpc: '2.0',
									id: message.id,
									result: {
										structuredContent: hostState.savedSource,
									},
								})
								return
							}
							if (message.params?.name === 'execute') {
								postToFrame({
									jsonrpc: '2.0',
									id: message.id,
									result: {
										structuredContent: {
											result: {
												phase:
													hostState.toolCalls.filter(
														(call) => call?.name === 'execute',
													).length === 1
														? 'inline'
														: 'saved',
												owner:
													hostState.renderData?.toolOutput?.params?.owner ??
													null,
											},
										},
									},
								})
							}
						}
					})
				</script>
			</body>
		</html>
	`)

	await page.waitForSelector('#generated-ui-frame')
	await page.waitForFunction(() => {
		return Boolean(
			(
				window as typeof window & {
					__generatedUiHostActions?: unknown
				}
			).__generatedUiHostActions,
		)
	})
	await page.evaluate(() => {
		;(
			window as typeof window & {
				__generatedUiHostActions: {
					renderInline: (params: Record<string, unknown>) => void
				}
			}
		).__generatedUiHostActions.renderInline({ owner: 'alpha' })
	})

	const frame = page.frameLocator('#generated-ui-frame')
	await expect(
		frame.getByRole('button', { name: 'First inline button' }),
	).toBeVisible()
	await expect(
		frame.getByRole('button', { name: 'Second inline button' }),
	).toBeVisible()
	await expect(frame.locator('body')).toHaveAttribute(
		'data-inline-execute',
		/alpha/,
	)
	await expect
		.poll(async () => {
			return await page.evaluate(() => {
				return (
					(
						window as typeof window & {
							__generatedUiHostState: { lastSize?: { height?: number } | null }
						}
					).__generatedUiHostState.lastSize?.height ?? 0
				)
			})
		})
		.toBeGreaterThan(0)

	await page.evaluate(() => {
		;(
			window as typeof window & {
				__generatedUiHostActions: {
					renderSaved: (params: Record<string, unknown>) => void
				}
			}
		).__generatedUiHostActions.renderSaved({ owner: 'beta', count: 2 })
	})

	await expect(frame.getByRole('button', { name: 'Saved app' })).toBeVisible()
	await expect(frame.locator('html')).toHaveAttribute(
		'data-shell-phase',
		'saved',
	)
	await expect(frame.locator('body')).toHaveAttribute(
		'data-shell-body',
		'saved',
	)
	await expect(frame.locator('body')).toHaveAttribute(
		'data-saved-execute',
		/beta/,
	)
	await expect(frame.locator('body')).toHaveAttribute(
		'data-saved-params',
		/beta/,
	)
	await expect(frame.locator('html')).toHaveAttribute(
		'data-saved-html-attr',
		'saved',
	)
	await expect
		.poll(async () => {
			return await page.evaluate(() => {
				return (
					window as typeof window & {
						__generatedUiHostState: {
							toolCalls: Array<{ name?: string }>
						}
					}
				).__generatedUiHostState.toolCalls.map((call) => call.name)
			})
		})
		.toEqual(['execute', 'ui_load_app_source', 'execute'])
})
