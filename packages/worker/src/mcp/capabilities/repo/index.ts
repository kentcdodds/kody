import { repoDomain } from './domain.ts'

export { repoDomain } from './domain.ts'
export { repoApplyPatchCapability } from './repo-apply-patch.ts'
export { repoDiscardSessionCapability } from './repo-discard-session.ts'
export { repoGetSessionCapability } from './repo-get-session.ts'
export { repoOpenSessionCapability } from './repo-open-session.ts'
export { repoReadFileCapability } from './repo-read-file.ts'
export { repoSearchCapability } from './repo-search.ts'
export { repoTreeCapability } from './repo-tree.ts'
export { repoWriteFileCapability } from './repo-write-file.ts'

export const repoCapabilities = repoDomain.capabilities
