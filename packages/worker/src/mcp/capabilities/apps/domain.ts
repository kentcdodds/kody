import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { uiDeleteAppCapability } from './ui-delete-app.ts'
import { uiGetAppCapability } from './ui-get-app.ts'
import { uiListAppsCapability } from './ui-list-apps.ts'
import { uiSaveAppCapability } from './ui-save-app.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description:
		'Generated MCP App artifacts that can be saved, listed, loaded, and reopened in the generic UI shell. Supports raw source persistence and app ids for reopening without re-sending saved source code through the model.',
	keywords: ['ui', 'app', 'mcp app', 'artifact', 'generated ui', 'shell'],
	capabilities: [
		uiSaveAppCapability,
		uiGetAppCapability,
		uiListAppsCapability,
		uiDeleteAppCapability,
	],
})
