export const calculatorUiResourceUri =
	'ui://calculator-app/entry-point.html' as const

export function renderCalculatorUiEntryPoint(baseUrl: string | URL) {
	const stylesheetHref = new URL('/styles.css', baseUrl).toString()
	const widgetScriptHref = new URL(
		'/mcp-apps/calculator-widget.js',
		baseUrl,
	).toString()

	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Calculator</title>
		<link rel="stylesheet" href="${stylesheetHref}" />
		<style>
			:root {
				color-scheme: light dark;
			}

			:root[data-theme='light'] {
				color-scheme: light;
			}

			:root[data-theme='dark'] {
				color-scheme: dark;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				padding: var(--spacing-md);
				font-family: var(--font-family);
				font-size: var(--font-size-base);
				color: var(--color-text);
				background: var(--color-background);
			}

			.calculator-root {
				width: min(100%, 28rem);
				margin: 0 auto;
				padding: var(--spacing-lg);
				display: grid;
				gap: var(--spacing-md);
				border-radius: var(--radius-lg);
				border: 1px solid var(--color-border);
				background-color: var(--color-surface);
				box-shadow: var(--shadow-sm);
			}

			.calculator-title {
				margin: 0;
				font-size: var(--font-size-lg);
				font-weight: var(--font-weight-semibold);
				color: var(--color-text);
			}

			.calculator-help {
				margin: 0;
				font-size: var(--font-size-sm);
				color: var(--color-text-muted);
			}

			.calculator-display {
				border-radius: var(--radius-md);
				padding: var(--spacing-md);
				background: color-mix(
					in srgb,
					var(--color-background) 72%,
					var(--color-surface)
				);
				border: 1px solid var(--color-border);
				min-height: 80px;
				display: grid;
				align-content: center;
				gap: var(--spacing-xs);
			}

			.calculator-expression {
				font-size: var(--font-size-sm);
				min-height: 1rem;
				color: var(--color-text-muted);
				word-break: break-word;
			}

			.calculator-result {
				font-size: var(--font-size-xl);
				line-height: 1;
				font-variant-numeric: tabular-nums;
				word-break: break-all;
				color: var(--color-text);
			}

			.calculator-keypad {
				display: grid;
				grid-template-columns: repeat(4, minmax(0, 1fr));
				gap: var(--spacing-sm);
			}

			.calculator-key {
				border: 1px solid var(--color-border);
				background-color: var(--color-background);
				color: var(--color-text);
				padding: var(--spacing-sm);
				border-radius: var(--radius-md);
				font-family: var(--font-family);
				font-size: var(--font-size-base);
				font-weight: var(--font-weight-medium);
				cursor: pointer;
				transition:
					transform var(--transition-fast),
					background-color var(--transition-normal),
					color var(--transition-normal),
					border-color var(--transition-normal);
			}

			.calculator-key:hover:not(:disabled) {
				background-color: color-mix(
					in srgb,
					var(--color-surface) 78%,
					var(--color-primary) 22%
				);
				transform: translateY(-1px);
			}

			.calculator-key:active {
				transform: translateY(1px);
			}

			.calculator-key:focus-visible {
				outline: 2px solid var(--color-primary);
				outline-offset: 1px;
			}

			.calculator-key.operator {
				background-color: var(--color-primary);
				border-color: transparent;
				color: var(--color-on-primary);
				font-weight: var(--font-weight-semibold);
			}

			.calculator-key.operator:hover:not(:disabled) {
				background-color: var(--color-primary-hover);
			}

			.calculator-key.operator:active {
				background-color: var(--color-primary-active);
			}

			.calculator-key.control,
			.calculator-key.utility {
				background-color: var(--color-surface);
			}

			.calculator-key.span-two {
				grid-column: span 2;
			}
		</style>
	</head>
	<body>
		<section class="calculator-root" data-calculator-ui>
			<header>
				<h1 class="calculator-title">Calculator</h1>
				<p class="calculator-help">Use keys, Enter, and Backspace.</p>
			</header>

			<div class="calculator-display" role="status" aria-live="polite">
				<div class="calculator-expression" data-expression>&nbsp;</div>
				<div class="calculator-result" data-result>0</div>
			</div>

			<div class="calculator-keypad" role="group" aria-label="Calculator keypad">
				<button class="calculator-key control" data-action="clear" type="button">C</button>
				<button class="calculator-key control" data-action="backspace" type="button">BS</button>
				<button class="calculator-key operator" data-action="operator" data-value="/" type="button">/</button>
				<button class="calculator-key operator" data-action="operator" data-value="*" type="button">*</button>

				<button class="calculator-key" data-action="digit" data-value="7" type="button">7</button>
				<button class="calculator-key" data-action="digit" data-value="8" type="button">8</button>
				<button class="calculator-key" data-action="digit" data-value="9" type="button">9</button>
				<button class="calculator-key operator" data-action="operator" data-value="-" type="button">-</button>

				<button class="calculator-key" data-action="digit" data-value="4" type="button">4</button>
				<button class="calculator-key" data-action="digit" data-value="5" type="button">5</button>
				<button class="calculator-key" data-action="digit" data-value="6" type="button">6</button>
				<button class="calculator-key operator" data-action="operator" data-value="+" type="button">+</button>

				<button class="calculator-key" data-action="digit" data-value="1" type="button">1</button>
				<button class="calculator-key" data-action="digit" data-value="2" type="button">2</button>
				<button class="calculator-key" data-action="digit" data-value="3" type="button">3</button>
				<button class="calculator-key operator" data-action="evaluate" type="button">=</button>

				<button class="calculator-key span-two" data-action="digit" data-value="0" type="button">
					0
				</button>
				<button class="calculator-key" data-action="decimal" type="button">.</button>
				<button class="calculator-key utility" data-action="reset" type="button">AC</button>
			</div>
		</section>

		<script type="module" src="${widgetScriptHref}" crossorigin="anonymous"></script>
	</body>
</html>
`.trim()
}
