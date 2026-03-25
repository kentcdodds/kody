import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { uiDeleteAppCapability } from './ui-delete-app.ts'
import { uiGeneratedUiInvokeActionCapability } from './ui-generated-ui-invoke-action.ts'
import { uiGeneratedUiSubmitSecureInputCapability } from './ui-generated-ui-submit-secure-input.ts'
import { uiGetAppCapability } from './ui-get-app.ts'
import { uiListAppsCapability } from './ui-list-apps.ts'
import { uiLoadAppSourceCapability } from './ui-load-app-source.ts'
import { uiSaveAppCapability } from './ui-save-app.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description:
		'Generated MCP App artifacts that can be saved, listed, loaded, and reopened in the generic UI shell. Supports raw source persistence, app ids, and app-only source loading for UI reopening without re-sending source to the model.',
	keywords: ['ui', 'app', 'mcp app', 'artifact', 'generated ui', 'shell'],
	capabilities: [
		uiSaveAppCapability,
		uiGetAppCapability,
		uiListAppsCapability,
		uiLoadAppSourceCapability,
		uiGeneratedUiInvokeActionCapability,
		uiGeneratedUiSubmitSecureInputCapability,
		uiDeleteAppCapability,
	],
})
