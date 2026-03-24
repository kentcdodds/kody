import { appsDomain } from './domain.ts'

export { appsDomain } from './domain.ts'
export { uiGetAppCapability } from './ui-get-app.ts'
export { uiListAppsCapability } from './ui-list-apps.ts'
export { uiLoadAppSourceCapability } from './ui-load-app-source.ts'
export { uiSaveAppCapability } from './ui-save-app.ts'

export const appsCapabilities = appsDomain.capabilities
