import { defineDomain } from '../define-domain.ts'
import { appDeleteCapability } from './app-delete.ts'
import { appGetCapability } from './app-get.ts'
import { appListCapability } from './app-list.ts'
import { appRunJobCapability } from './app-run-job.ts'
import { appRunTaskCapability } from './app-run-task.ts'
import { appSaveCapability } from './app-save.ts'
import { appServerExecCapability } from './app-server-exec.ts'
import { appStorageExportCapability } from './app-storage-export.ts'
import { appStorageResetCapability } from './app-storage-reset.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description:
		'Personal apps are the top-level repo-backed unit in Kody. An app can include client UI, a server backend, named tasks, and scheduled jobs.',
	keywords: ['app', 'apps', 'package', 'tasks', 'jobs', 'ui', 'server'],
	capabilities: [
		appSaveCapability,
		appGetCapability,
		appListCapability,
		appRunTaskCapability,
		appRunJobCapability,
		appStorageResetCapability,
		appStorageExportCapability,
		appServerExecCapability,
		appDeleteCapability,
	],
})
