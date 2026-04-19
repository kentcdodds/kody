import { defineDomain } from '../define-domain.ts'
import { appDeleteCapability } from './app-delete.ts'
import { appServerExecCapability } from './app-server-exec.ts'
import { appStorageExportCapability } from './app-storage-export.ts'
import { appStorageResetCapability } from './app-storage-reset.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { uiDeleteAppCapability } from './ui-delete-app.ts'
import { uiGetAppCapability } from './ui-get-app.ts'
import { uiListAppsCapability } from './ui-list-apps.ts'
import { uiLoadAppSourceCapability } from './ui-load-app-source.ts'
import { uiSaveAppCapability } from './ui-save-app.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description:
		'Generated MCP App artifacts that can be saved, listed, loaded, and reopened in the generic UI shell. Saved apps keep metadata in D1 and load their client/server source from repo-backed snapshots so they can reopen by app id without re-sending source to the model.',
	keywords: ['ui', 'app', 'mcp app', 'artifact', 'generated ui', 'shell'],
	capabilities: [
		uiSaveAppCapability,
		uiGetAppCapability,
		uiListAppsCapability,
		uiLoadAppSourceCapability,
		uiDeleteAppCapability,
		appStorageResetCapability,
		appStorageExportCapability,
		appServerExecCapability,
		appDeleteCapability,
	],
})
