const EXAMPLE_IDENTIFIER = '__oxlint_plugin_example__'

const noExampleIdentifierRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Demonstrates how to author a custom oxlint JS plugin rule in this repo.',
		},
		schema: [],
		messages: {
			avoidExampleIdentifier:
				'Avoid using __oxlint_plugin_example__. This identifier exists only to verify the custom oxlint rule example.',
		},
	},
	createOnce(context) {
		return {
			Identifier(node) {
				if (node.name !== EXAMPLE_IDENTIFIER) return
				context.report({ node, messageId: 'avoidExampleIdentifier' })
			},
		}
	},
}

function isLiteralFrameSrc(value) {
	if (!value) return false
	if (value.type === 'Literal' && typeof value.value === 'string') return true
	if (value.type !== 'JSXExpressionContainer') return false
	const expression = value.expression
	if (expression.type === 'Literal' && typeof expression.value === 'string') {
		return true
	}
	return expression.type === 'TemplateLiteral'
}

const noLiteralFrameSrcRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require typed route href() expressions for Remix Frame src props.',
		},
		schema: [],
		messages: {
			useRoutesHref:
				'<Frame src> must use routes.<name>.href(...) instead of a string or template literal.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Frame') {
					return
				}

				for (const attribute of node.attributes) {
					if (attribute.type !== 'JSXAttribute') continue
					if (
						attribute.name.type !== 'JSXIdentifier' ||
						attribute.name.name !== 'src'
					) {
						continue
					}
					if (!isLiteralFrameSrc(attribute.value)) continue
					context.report({ node: attribute, messageId: 'useRoutesHref' })
				}
			},
		}
	},
}

const plugin = {
	meta: { name: 'kody-custom' },
	rules: {
		'no-example-identifier': noExampleIdentifierRule,
		'no-literal-frame-src': noLiteralFrameSrcRule,
	},
}

export default plugin
