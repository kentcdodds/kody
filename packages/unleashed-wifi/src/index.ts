import { acknowledgeAlarm } from './acknowledge-alarm.ts'
import { addDpsk } from './add-dpsk.ts'
import { addWlan } from './add-wlan.ts'
import { addWlanGroup } from './add-wlan-group.ts'
import { blockClient } from './block-client.ts'
import { clearAllAlarms } from './clear-all-alarms.ts'
import { cloneWlan } from './clone-wlan.ts'
import { cloneWlanGroup } from './clone-wlan-group.ts'
import { deleteDpsk } from './delete-dpsk.ts'
import { deleteWlan } from './delete-wlan.ts'
import { deleteWlanGroup } from './delete-wlan-group.ts'
import { disableWlan } from './disable-wlan.ts'
import { editWlan } from './edit-wlan.ts'
import { enableWlan } from './enable-wlan.ts'
import { getApGroupStats } from './get-ap-group-stats.ts'
import { getMeshInfo } from './get-mesh-info.ts'
import { getStatus } from './get-status.ts'
import { getSyslog } from './get-syslog.ts'
import { getVapStats } from './get-vap-stats.ts'
import { getWlanGroupStats } from './get-wlan-group-stats.ts'
import { hideApLeds } from './hide-ap-leds.ts'
import { listAccessPoints } from './list-access-points.ts'
import { listActiveRogues } from './list-active-rogues.ts'
import { listAlarms } from './list-alarms.ts'
import { listApGroups } from './list-ap-groups.ts'
import { listBlockedClients } from './list-blocked-clients.ts'
import { listBlockedRogues } from './list-blocked-rogues.ts'
import { listClients } from './list-clients.ts'
import { listDpsks } from './list-dpsks.ts'
import { listEvents } from './list-events.ts'
import { listInactiveClients } from './list-inactive-clients.ts'
import { listKnownRogues } from './list-known-rogues.ts'
import { listWlanGroups } from './list-wlan-groups.ts'
import { listWlans } from './list-wlans.ts'
import { markRogueBlocked } from './mark-rogue-blocked.ts'
import { markRogueKnown } from './mark-rogue-known.ts'
import { rebootController } from './reboot-controller.ts'
import { restartAccessPoint } from './restart-access-point.ts'
import { setWlanPassword } from './set-wlan-password.ts'
import { showApLeds } from './show-ap-leds.ts'
import { unblockClient } from './unblock-client.ts'
import { unmarkRogue } from './unmark-rogue.ts'
import { updateAp } from './update-ap.ts'
import { upgradeApFirmware } from './upgrade-ap-firmware.ts'

export { acknowledgeAlarm } from './acknowledge-alarm.ts'
export { addDpsk, type AddDpskOptions } from './add-dpsk.ts'
export { addWlan, type AddWlanOptions } from './add-wlan.ts'
export { addWlanGroup } from './add-wlan-group.ts'
export { blockClient } from './block-client.ts'
export { clearAllAlarms } from './clear-all-alarms.ts'
export { cloneWlan } from './clone-wlan.ts'
export { cloneWlanGroup } from './clone-wlan-group.ts'
export { deleteDpsk } from './delete-dpsk.ts'
export { deleteWlan } from './delete-wlan.ts'
export { deleteWlanGroup } from './delete-wlan-group.ts'
export { disableWlan } from './disable-wlan.ts'
export { editWlan, type EditWlanChanges } from './edit-wlan.ts'
export { enableWlan } from './enable-wlan.ts'
export { getApGroupStats } from './get-ap-group-stats.ts'
export { getMeshInfo } from './get-mesh-info.ts'
export { getStatus, type UnleashedSystemSummary } from './get-status.ts'
export { getSyslog } from './get-syslog.ts'
export { getVapStats } from './get-vap-stats.ts'
export { getWlanGroupStats } from './get-wlan-group-stats.ts'
export { hideApLeds } from './hide-ap-leds.ts'
export { listAccessPoints } from './list-access-points.ts'
export { listActiveRogues } from './list-active-rogues.ts'
export { listAlarms } from './list-alarms.ts'
export { listApGroups } from './list-ap-groups.ts'
export { listBlockedClients } from './list-blocked-clients.ts'
export { listBlockedRogues } from './list-blocked-rogues.ts'
export { listClients } from './list-clients.ts'
export { listDpsks } from './list-dpsks.ts'
export { listEvents } from './list-events.ts'
export { listInactiveClients } from './list-inactive-clients.ts'
export { listKnownRogues } from './list-known-rogues.ts'
export { listWlanGroups } from './list-wlan-groups.ts'
export { listWlans } from './list-wlans.ts'
export { markRogueBlocked } from './mark-rogue-blocked.ts'
export { markRogueKnown } from './mark-rogue-known.ts'
export { rebootController } from './reboot-controller.ts'
export { restartAccessPoint } from './restart-access-point.ts'
export { setWlanPassword } from './set-wlan-password.ts'
export { showApLeds } from './show-ap-leds.ts'
export { unblockClient } from './unblock-client.ts'
export { unmarkRogue } from './unmark-rogue.ts'
export { updateAp, type UpdateApChanges } from './update-ap.ts'
export { upgradeApFirmware } from './upgrade-ap-firmware.ts'

export {
	type UnleashedAjaxAction,
	type UnleashedRequestResult,
} from './internal/request.ts'
export { type UnleashedRecord } from './internal/xml.ts'

/**
 * Default namespace export so callers can do
 * `import unleashed from 'kody:@kentcdodds/unleashed-wifi'` and call
 * `unleashed().listClients()`, `unleashed().disableWlan({ name: 'Guest' })`,
 * etc. Kody surfaces only the package root's `default` export to consumers,
 * so this namespace is the way to reach the named helpers from outside the
 * package.
 */
const unleashedWifi = {
	acknowledgeAlarm,
	addDpsk,
	addWlan,
	addWlanGroup,
	blockClient,
	clearAllAlarms,
	cloneWlan,
	cloneWlanGroup,
	deleteDpsk,
	deleteWlan,
	deleteWlanGroup,
	disableWlan,
	editWlan,
	enableWlan,
	getApGroupStats,
	getMeshInfo,
	getStatus,
	getSyslog,
	getVapStats,
	getWlanGroupStats,
	hideApLeds,
	listAccessPoints,
	listActiveRogues,
	listAlarms,
	listApGroups,
	listBlockedClients,
	listBlockedRogues,
	listClients,
	listDpsks,
	listEvents,
	listInactiveClients,
	listKnownRogues,
	listWlanGroups,
	listWlans,
	markRogueBlocked,
	markRogueKnown,
	rebootController,
	restartAccessPoint,
	setWlanPassword,
	showApLeds,
	unblockClient,
	unmarkRogue,
	updateAp,
	upgradeApFirmware,
} as const

export type UnleashedWifi = typeof unleashedWifi

/** Kody package default exports must be callable; calling this package returns the namespace. */
function unleashedWifiPackage() {
	return unleashedWifi
}
export default unleashedWifiPackage
