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

const plugin = {
	meta: { name: 'kody-custom' },
	rules: {
		'no-example-identifier': noExampleIdentifierRule,
	},
}

export default plugin
