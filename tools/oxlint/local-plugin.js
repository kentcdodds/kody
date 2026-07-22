const EXAMPLE_IDENTIFIER = '__oxlint_plugin_example__'
const CLIENT_ROUTE_FILE_PATTERN =
	/(^|\/)packages\/worker\/client\/routes\/.+\.(ts|tsx)$/
const SHARED_LOADER_DATA_TYPE_NAMES = new Set([
	'AccountSecretListItem',
	'AccountSecretDetail',
	'AccountSecretsLoaderData',
	'AccountPackageInvocationTokenListItem',
	'AccountPackageInvocationTokensLoaderData',
	'AccountIntegrationsLoaderData',
	'AccountIntegrationListItem',
])

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

function normalizeFilePath(filename) {
	return typeof filename === 'string' ? filename.replaceAll('\\', '/') : ''
}

function isClientRouteFile(filename) {
	return CLIENT_ROUTE_FILE_PATTERN.test(normalizeFilePath(filename))
}

function shouldImportSharedLoaderDataType(typeName) {
	if (!typeName) return false
	return (
		typeName.endsWith('LoaderData') ||
		SHARED_LOADER_DATA_TYPE_NAMES.has(typeName)
	)
}

function getDeclaredTypeName(node) {
	if (!node?.id || node.id.type !== 'Identifier') return null
	return node.id.name
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

const preferLoaderDataTypesRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require client routes to import shared loader-data payload types instead of redeclaring them locally.',
		},
		schema: [],
		messages: {
			importFromLoaderData:
				'Import shared payload types from #app/loader-data.ts instead of redeclaring this type in a client route.',
		},
	},
	createOnce(context) {
		let shouldCheckCurrentFile = false

		function reportIfNeeded(node) {
			if (!shouldCheckCurrentFile) return
			const typeName = getDeclaredTypeName(node)
			if (!shouldImportSharedLoaderDataType(typeName)) return
			context.report({ node, messageId: 'importFromLoaderData' })
		}

		return {
			Program() {
				shouldCheckCurrentFile = isClientRouteFile(context.filename)
			},
			TSTypeAliasDeclaration(node) {
				reportIfNeeded(node)
			},
			TSInterfaceDeclaration(node) {
				reportIfNeeded(node)
			},
		}
	},
}

const plugin = {
	meta: { name: 'kody-custom' },
	rules: {
		'no-example-identifier': noExampleIdentifierRule,
		'no-literal-frame-src': noLiteralFrameSrcRule,
		'prefer-loader-data-types': preferLoaderDataTypesRule,
	},
}

export default plugin
