import { journalingDomain } from './domain.ts'

export { journalingDomain } from './domain.ts'
export { journalCreateEntryCapability } from './journal-create-entry.ts'
export { journalDeleteEntryCapability } from './journal-delete-entry.ts'
export { journalGetEntryCapability } from './journal-get-entry.ts'
export { journalListEntriesCapability } from './journal-list-entries.ts'
export { journalSearchEntriesCapability } from './journal-search-entries.ts'
export { journalUpdateEntryCapability } from './journal-update-entry.ts'
export {
	buildJournalEntryEmbedText,
	deleteJournalEntryVector,
	journalEntryVectorId,
	searchJournalEntriesSemantic,
	upsertJournalEntryVector,
} from './journal-vectorize.ts'

export const journalingCapabilities = journalingDomain.capabilities
