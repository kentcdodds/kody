import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { journalCreateEntryCapability } from './journal-create-entry.ts'
import { journalDeleteEntryCapability } from './journal-delete-entry.ts'
import { journalGetEntryCapability } from './journal-get-entry.ts'
import { journalListEntriesCapability } from './journal-list-entries.ts'
import { journalSearchEntriesCapability } from './journal-search-entries.ts'
import { journalUpdateEntryCapability } from './journal-update-entry.ts'

export const journalingDomain = defineDomain({
	name: capabilityDomainNames.journaling,
	description:
		'Personal journal entry capture, retrieval, search, recent-entry listing, updates, and deletion for the signed-in user.',
	keywords: [
		'journal',
		'journaling',
		'diary',
		'reflection',
		'notes',
		'memory',
		'entry',
	],
	capabilities: [
		journalCreateEntryCapability,
		journalGetEntryCapability,
		journalUpdateEntryCapability,
		journalListEntriesCapability,
		journalSearchEntriesCapability,
		journalDeleteEntryCapability,
	],
})
