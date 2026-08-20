export type RecordTableSearchSync = {
	lastExternalValue: string
	pendingExternalValue: string | null
}

/**
 * The reader just typed this string, so the coming URL update is theirs.
 * Record it as the last applied value and drop any deferred external string
 * so blur cannot write stale text back into the field.
 */
export function acknowledgeRecordTableSearchInput(
	value: string,
): RecordTableSearchSync {
	return { lastExternalValue: value, pendingExternalValue: null }
}

/**
 * Reconcile an incoming `value` prop (URL / back-button) with the last
 * applied or typed string. Focused changes wait for blur; a return to the
 * last applied value clears a stale pending string instead of keeping it.
 */
export function reconcileRecordTableSearchExternalValue(
	state: RecordTableSearchSync,
	nextValue: string,
	focused: boolean,
): { state: RecordTableSearchSync; applyValue: string | null } {
	if (nextValue === state.lastExternalValue) {
		return {
			state: {
				lastExternalValue: state.lastExternalValue,
				pendingExternalValue: null,
			},
			applyValue: null,
		}
	}
	if (focused) {
		return {
			state: {
				lastExternalValue: state.lastExternalValue,
				pendingExternalValue: nextValue,
			},
			applyValue: null,
		}
	}
	return {
		state: {
			lastExternalValue: nextValue,
			pendingExternalValue: null,
		},
		applyValue: nextValue,
	}
}
