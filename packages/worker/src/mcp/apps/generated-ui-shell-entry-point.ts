export const generatedUiShellResourceUri =
	'ui://generated-ui-shell/entry-point.html' as const

export function renderGeneratedUiShellEntryPoint(baseUrl: string | URL) {
	const widgetScriptHref = new URL(
		'/mcp-apps/generated-ui-shell.js',
		baseUrl,
	).toString()

	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Generated UI Shell</title>
		<style>
			html,
			body {
				margin: 0;
				height: 100%;
				background: transparent;
			}

			body {
				overflow: hidden;
			}

			iframe {
				display: block;
				width: 100%;
				height: 100%;
				border: 0;
				background: transparent;
			}
		</style>
	</head>
	<body>
		<iframe data-generated-ui-frame title="Generated UI"></iframe>
		<script type="module" src="${widgetScriptHref}" crossorigin="anonymous"></script>
	</body>
</html>
`.trim()
}
