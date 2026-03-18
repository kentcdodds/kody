import { createWidgetHostBridge } from './widget-host-bridge.js'

type CalculatorOperator = '+' | '-' | '*' | '/'

type CalculatorState = {
	leftOperand: number | null
	operator: CalculatorOperator | null
	displayValue: string
	waitingForNextOperand: boolean
	expressionText: string
}

function readTheme(source: Record<string, unknown> | undefined) {
	const theme = source?.theme
	return theme === 'dark' || theme === 'light' ? theme : undefined
}

function initializeCalculatorWidget() {
	const documentRef = globalThis.document
	const windowRef = globalThis.window
	if (!documentRef || !windowRef) return

	const rootElement = documentRef.documentElement
	const expressionElement =
		documentRef.querySelector<HTMLElement>('[data-expression]')
	const resultElement = documentRef.querySelector<HTMLElement>('[data-result]')
	const keyElements = Array.from(
		documentRef.querySelectorAll<HTMLElement>('[data-action]'),
	)

	if (!expressionElement || !resultElement) {
		return
	}
	const expressionDisplayElement = expressionElement
	const resultDisplayElement = resultElement

	const state: CalculatorState = {
		leftOperand: null,
		operator: null,
		displayValue: '0',
		waitingForNextOperand: false,
		expressionText: '',
	}

	function applyTheme(theme: string | undefined) {
		if (theme === 'dark' || theme === 'light') {
			rootElement.setAttribute('data-theme', theme)
			return
		}
		rootElement.removeAttribute('data-theme')
	}

	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'calculator-widget',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			applyTheme(readTheme(renderData))
		},
		onHostContextChanged: (hostContext) => {
			applyTheme(readTheme(hostContext))
		},
	})

	function formatNumber(value: number) {
		if (!Number.isFinite(value)) return 'Error'
		return Number(value.toPrecision(12)).toString()
	}

	function compute(
		left: number,
		operator: CalculatorOperator | null,
		right: number,
	): number | null {
		if (operator === '+') return left + right
		if (operator === '-') return left - right
		if (operator === '*') return left * right
		if (operator === '/') {
			if (right === 0) return null
			return left / right
		}
		return right
	}

	function updateView() {
		expressionDisplayElement.textContent = state.expressionText || ' '
		resultDisplayElement.textContent = state.displayValue
	}

	function sendResultToHostAgent(expression: string, resultValue: string) {
		const prompt = 'Calculator result: ' + expression + ' = ' + resultValue
		void hostBridge.sendUserMessageWithFallback(prompt)
	}

	function resetAll() {
		state.leftOperand = null
		state.operator = null
		state.displayValue = '0'
		state.waitingForNextOperand = false
		state.expressionText = ''
		updateView()
	}

	function setError() {
		state.leftOperand = null
		state.operator = null
		state.displayValue = 'Error'
		state.waitingForNextOperand = true
		state.expressionText = 'Invalid operation'
		updateView()
	}

	function addDigit(digit: string) {
		if (state.displayValue === 'Error' || state.waitingForNextOperand) {
			state.displayValue = digit
			state.waitingForNextOperand = false
			updateView()
			return
		}

		state.displayValue =
			state.displayValue === '0' ? digit : state.displayValue + digit
		updateView()
	}

	function addDecimal() {
		if (state.displayValue === 'Error' || state.waitingForNextOperand) {
			state.displayValue = '0.'
			state.waitingForNextOperand = false
			updateView()
			return
		}

		if (!state.displayValue.includes('.')) {
			state.displayValue += '.'
			updateView()
		}
	}

	function removeLastCharacter() {
		if (state.displayValue === 'Error' || state.waitingForNextOperand) {
			state.displayValue = '0'
			state.waitingForNextOperand = false
			updateView()
			return
		}

		state.displayValue = state.displayValue.slice(0, -1) || '0'
		updateView()
	}

	function useOperator(nextOperator: CalculatorOperator) {
		const inputValue = Number(state.displayValue)
		if (!Number.isFinite(inputValue)) {
			setError()
			return
		}

		if (state.operator && state.waitingForNextOperand) {
			state.operator = nextOperator
			state.expressionText =
				formatNumber(state.leftOperand ?? 0) + ' ' + nextOperator
			updateView()
			return
		}

		if (state.leftOperand === null || state.operator === null) {
			state.leftOperand = inputValue
		} else {
			const result = compute(state.leftOperand, state.operator, inputValue)
			if (result === null || !Number.isFinite(result)) {
				setError()
				return
			}
			state.leftOperand = result
			state.displayValue = formatNumber(result)
		}

		state.operator = nextOperator
		state.waitingForNextOperand = true
		state.expressionText = formatNumber(state.leftOperand) + ' ' + nextOperator
		updateView()
	}

	function evaluateExpression() {
		if (
			state.operator === null ||
			state.leftOperand === null ||
			state.waitingForNextOperand
		) {
			return
		}

		const rightOperand = Number(state.displayValue)
		const result = compute(state.leftOperand, state.operator, rightOperand)
		if (result === null || !Number.isFinite(result)) {
			setError()
			return
		}

		const expression =
			formatNumber(state.leftOperand) +
			' ' +
			state.operator +
			' ' +
			formatNumber(rightOperand)

		state.displayValue = formatNumber(result)
		state.leftOperand = result
		state.operator = null
		state.waitingForNextOperand = true
		state.expressionText = expression + ' ='
		updateView()
		sendResultToHostAgent(expression, state.displayValue)
	}

	function handleAction(action: string | null, value: string | null) {
		if (action === 'digit' && value) return addDigit(value)
		if (action === 'decimal') return addDecimal()
		if (action === 'operator' && value) {
			if (value === '+' || value === '-' || value === '*' || value === '/') {
				return useOperator(value)
			}
			return
		}
		if (action === 'evaluate') return evaluateExpression()
		if (action === 'clear') {
			state.displayValue = '0'
			state.waitingForNextOperand = false
			updateView()
			return
		}
		if (action === 'backspace') return removeLastCharacter()
		if (action === 'reset') return resetAll()
	}

	for (const keyElement of keyElements) {
		keyElement.addEventListener('click', () => {
			handleAction(
				keyElement.getAttribute('data-action'),
				keyElement.getAttribute('data-value'),
			)
		})
	}

	documentRef.addEventListener('keydown', (event) => {
		if (event.key >= '0' && event.key <= '9') {
			event.preventDefault()
			addDigit(event.key)
			return
		}
		if (event.key === '.') {
			event.preventDefault()
			addDecimal()
			return
		}
		if (event.key === 'Enter' || event.key === '=') {
			event.preventDefault()
			evaluateExpression()
			return
		}
		if (
			event.key === '+' ||
			event.key === '-' ||
			event.key === '*' ||
			event.key === '/'
		) {
			event.preventDefault()
			useOperator(event.key)
			return
		}
		if (event.key === 'Backspace') {
			event.preventDefault()
			removeLastCharacter()
			return
		}
		if (event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey) {
			event.preventDefault()
			handleAction('clear', null)
		}
	})

	windowRef.addEventListener('message', (event) => {
		hostBridge.handleHostMessage(event.data)
	})

	void hostBridge.initialize()
	hostBridge.requestRenderData()
	updateView()
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializeCalculatorWidget, {
		once: true,
	})
} else {
	initializeCalculatorWidget()
}
