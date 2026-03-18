import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type MCP } from '#mcp/index.ts'

type OperationFn = (left: number, right: number) => number
type MathOperator = '+' | '-' | '*' | '/'

const operations = {
	'+': (left: number, right: number) => left + right,
	'-': (left: number, right: number) => left - right,
	'*': (left: number, right: number) => left * right,
	'/': (left: number, right: number) => left / right,
} satisfies Record<MathOperator, OperationFn>

const mathOperators = Object.keys(operations) as Array<MathOperator>

const doMathTool = {
	name: 'do_math',
	title: 'Do Math',
	description: `
Compute a single arithmetic operation over two numbers.

Behavior:
- Division by zero is rejected.

Examples:
- "Add 8 and 4" → { left: 8, operator: "+", right: 4 }
- "Divide 1 by 3 with 3 decimals" → { left: 1, operator: "/", right: 3, precision: 3 }
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

function formatNumberForMarkdown(value: number, precision: number) {
	if (Number.isInteger(value)) return String(value)
	const rounded = value.toFixed(precision)
	return rounded.includes('.') ? rounded.replace(/\.?0+$/, '') : rounded
}

export async function registerDoMathTool(agent: MCP) {
	agent.server.registerTool(
		doMathTool.name,
		{
			title: doMathTool.title,
			description: doMathTool.description,
			inputSchema: {
				left: z
					.number()
					.finite()
					.describe('Left operand (finite number). Example: 8'),
				right: z
					.number()
					.finite()
					.describe('Right operand (finite number). Example: 4'),
				operator: z
					.enum(mathOperators)
					.describe('Operator. Valid values: "+", "-", "*", "/".'),
				precision: z
					.number()
					.int()
					.min(0)
					.max(15)
					.optional()
					.default(6)
					.describe(
						'Decimal places used ONLY for the markdown output (0-15, default: 6). Does not change the computed numeric result.',
					),
			},
			annotations: doMathTool.annotations,
		},
		async ({
			left,
			right,
			operator,
			precision,
		}: {
			left: number
			right: number
			operator: MathOperator
			precision: number
		}) => {
			if (operator === '/' && right === 0) {
				return {
					content: [
						{
							type: 'text',
							text: `
❌ Division by zero.

Inputs: left=${left}, operator="${operator}", right=${right}

Next: Choose a non-zero right operand.
							`.trim(),
						},
					],
					structuredContent: {
						error: 'DIVISION_BY_ZERO',
						left,
						operator,
						right,
					},
					isError: true,
				}
			}

			const operation = operations[operator]
			const result = operation(left, right)
			if (!Number.isFinite(result)) {
				return {
					content: [
						{
							type: 'text',
							text: `
❌ Result is not a finite number.

Inputs: left=${left}, operator="${operator}", right=${right}

Next: Use smaller inputs or choose a different operator.
							`.trim(),
						},
					],
					structuredContent: {
						error: 'NON_FINITE_RESULT',
						left,
						operator,
						right,
					},
					isError: true,
				}
			}

			const expression = `${left} ${operator} ${right}`
			const markdownResult = formatNumberForMarkdown(result, precision)
			return {
				content: [
					{
						type: 'text',
						text: `
## ✅ Result

**Expression**: \`${expression}\`

**Result**: \`${markdownResult}\`
						`.trim(),
					},
				],
				structuredContent: {
					left,
					operator,
					right,
					expression,
					result,
					precisionUsed: precision,
				},
			}
		},
	)
}
