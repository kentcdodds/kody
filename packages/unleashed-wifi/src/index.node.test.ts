import { beforeEach, describe, expect, test } from 'vitest'
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
import {
	getRecordedRequests,
	queueUnleashedResponse,
	resetUnleashedRuntime,
} from './test-helpers.node.ts'
import { unblockClient } from './unblock-client.ts'
import { unmarkRogue } from './unmark-rogue.ts'
import { updateAp } from './update-ap.ts'
import { upgradeApFirmware } from './upgrade-ap-firmware.ts'

beforeEach(() => {
	resetUnleashedRuntime()
})

describe('read operations', () => {
	test('get-status pulls system identity, sysinfo, and unleashed-network', async () => {
		queueUnleashedResponse({
			xml:
				'<ajax-response>' +
				"<system name='Unleashed-Master'>" +
				"<identity name='Office Network'/>" +
				"<sysinfo version='200.15.6.212' uptime='3600'/>" +
				"<unleashed-network id='abc'/>" +
				'</system></ajax-response>',
		})
		const status = await getStatus()
		expect(getRecordedRequests()).toHaveLength(1)
		expect(getRecordedRequests()[0]).toMatchObject({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<identity/><sysinfo/><unleashed-network/>',
		})
		expect(status.identity).toMatchObject({ name: 'Office Network' })
		expect(status.sysinfo).toMatchObject({ version: '200.15.6.212' })
		expect(status.unleashedNetwork).toMatchObject({ id: 'abc' })
	})

	test('list-access-points uses the apStat component', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><ap mac='aa:bb:cc:dd:ee:ff' name='Kitchen AP'/></ajax-response>",
		})
		const result = await listAccessPoints()
		expect(getRecordedRequests()[0]).toMatchObject({
			action: 'getstat',
			comp: 'apStat',
			xmlBody: '<apStat/>',
		})
		expect(result.items).toHaveLength(1)
		expect(result.items[0]).toMatchObject({ name: 'Kitchen AP' })
	})

	test('list-clients uses the stamgr component with <client/>', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><client mac='11:22:33:44:55:66' hostname='phone'/></ajax-response>",
		})
		const result = await listClients()
		expect(getRecordedRequests()[0]).toMatchObject({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: '<client/>',
		})
		expect(result.items).toHaveLength(1)
	})

	test('list-inactive-clients sends INACTIVE-STATS yes', async () => {
		await listInactiveClients()
		expect(getRecordedRequests()[0]).toMatchObject({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: '<client INACTIVE-STATS="yes"/>',
		})
	})

	test('list-wlans uses wlan-cfg', async () => {
		await listWlans()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'stamgr',
			xmlBody: '<wlan-cfg/>',
		})
	})

	test('list-wlan-groups uses wlan-group', async () => {
		await listWlanGroups()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'stamgr',
			xmlBody: '<wlan-group/>',
		})
	})

	test('list-ap-groups uses apStat', async () => {
		await listApGroups()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'apStat',
			xmlBody: '<ap-group/>',
		})
	})

	test('list-events defaults to limit=100 and clamps user input', async () => {
		await listEvents()
		expect(getRecordedRequests()[0]).toMatchObject({
			xmlBody: '<event limit="100"/>',
		})
		await listEvents({ limit: 5 })
		expect(getRecordedRequests()[1]).toMatchObject({
			xmlBody: '<event limit="5"/>',
		})
		await listEvents({ limit: 99_999 })
		expect(getRecordedRequests()[2]).toMatchObject({
			xmlBody: '<event limit="1000"/>',
		})
	})

	test('list-alarms defaults to limit=50', async () => {
		await listAlarms()
		expect(getRecordedRequests()[0]).toMatchObject({
			xmlBody: '<alarm limit="50"/>',
		})
		await listAlarms({ limit: 7 })
		expect(getRecordedRequests()[1]).toMatchObject({
			xmlBody: '<alarm limit="7"/>',
		})
	})

	test('list-blocked-clients uses blocked-client', async () => {
		await listBlockedClients()
		expect(getRecordedRequests()[0]).toMatchObject({
			xmlBody: '<blocked-client/>',
		})
	})

	test('list-dpsks uses dpsk', async () => {
		await listDpsks()
		expect(getRecordedRequests()[0]).toMatchObject({ xmlBody: '<dpsk/>' })
	})

	test('get-mesh-info uses system mesh', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><mesh enabled='true'/></ajax-response>",
		})
		const result = await getMeshInfo()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'system',
			xmlBody: '<mesh/>',
		})
		expect(result.mesh).toMatchObject({ enabled: true })
	})

	test('get-syslog extracts xmsg/res text', async () => {
		queueUnleashedResponse({
			xml: '<ajax-response><xmsg><res>line1\nline2</res></xmsg></ajax-response>',
		})
		const result = await getSyslog()
		expect(result.syslog).toContain('line1')
	})

	test('get-vap-stats uses stamgr vap', async () => {
		await getVapStats()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'stamgr',
			xmlBody: '<vap/>',
		})
	})

	test('get-wlan-group-stats appends STATS=yes', async () => {
		await getWlanGroupStats()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'stamgr',
			xmlBody: '<wlan-group STATS="yes"/>',
		})
	})

	test('get-ap-group-stats appends STATS=yes', async () => {
		await getApGroupStats()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'apStat',
			xmlBody: '<ap-group STATS="yes"/>',
		})
	})

	test('list-active-rogues uses stamgr rogue', async () => {
		await listActiveRogues()
		expect(getRecordedRequests()[0]).toMatchObject({
			comp: 'stamgr',
			xmlBody: '<rogue/>',
		})
	})

	test('list-known-rogues uses known-rogue', async () => {
		await listKnownRogues()
		expect(getRecordedRequests()[0]).toMatchObject({
			xmlBody: '<known-rogue/>',
		})
	})

	test('list-blocked-rogues uses blocked-rogue', async () => {
		await listBlockedRogues()
		expect(getRecordedRequests()[0]).toMatchObject({
			xmlBody: '<blocked-rogue/>',
		})
	})
})

describe('mutation operations', () => {
	test('block-client emits a docmd block envelope', async () => {
		const result = await blockClient({ mac: 'AA-BB-CC-DD-EE-FF' })
		expect(result.mac).toBe('aa:bb:cc:dd:ee:ff')
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({
			action: 'docmd',
			comp: 'stamgr',
		})
		expect(recorded?.xmlBody).toContain("client='aa:bb:cc:dd:ee:ff'")
		expect(recorded?.xmlBody).toContain("cmd='block'")
	})

	test('unblock-client preserves unrelated deny entries', async () => {
		queueUnleashedResponse({
			xml:
				'<ajax-response><acl-list>' +
				"<acl id='1' name='System' default-mode='allow' EDITABLE='false'>" +
				"<deny mac='aa:bb:cc:dd:ee:ff' type='single'/>" +
				"<deny mac='11:22:33:44:55:66' type='single'/>" +
				'</acl></acl-list></ajax-response>',
		})
		await unblockClient({ mac: 'aa:bb:cc:dd:ee:ff' })
		const updateCall = getRecordedRequests()[1]
		expect(updateCall?.action).toBe('setconf')
		expect(updateCall?.xmlBody).toContain("<deny mac='11:22:33:44:55:66'")
		expect(updateCall?.xmlBody).not.toContain("<deny mac='aa:bb:cc:dd:ee:ff'")
	})

	test('disable-wlan looks up the wlan id and emits enable-type=1', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><wlansvc id='42' name='Main' ssid='Main'/></ajax-response>",
		})
		await disableWlan({ name: 'Main' })
		expect(getRecordedRequests()[1]).toMatchObject({
			action: 'setconf',
			comp: 'stamgr',
		})
		expect(getRecordedRequests()[1]?.xmlBody).toContain("id='42'")
		expect(getRecordedRequests()[1]?.xmlBody).toContain("enable-type='1'")
	})

	test('enable-wlan emits enable-type=0', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><wlansvc id='1' name='Main' ssid='Main'/></ajax-response>",
		})
		await enableWlan({ name: 'Main' })
		expect(getRecordedRequests()[1]?.xmlBody).toContain("enable-type='0'")
	})

	test('set-wlan-password rotates passphrase on the existing element', async () => {
		queueUnleashedResponse({
			xml:
				"<ajax-response><wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>" +
				"<wpa cipher='aes' passphrase='oldpass' dynamic-psk='disabled'/>" +
				'</wlansvc></ajax-response>',
		})
		await setWlanPassword({ name: 'Main', passphrase: 'new-strong-pass' })
		const updateBody = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(updateBody).toContain("passphrase='new-strong-pass'")
		expect(updateBody).not.toContain('oldpass')
	})

	test('add-wlan emits a new wlansvc with the SSID and passphrase', async () => {
		await addWlan({ ssid: 'NewNet', passphrase: 'a-strong-passphrase' })
		const body = getRecordedRequests()[0]?.xmlBody ?? ''
		expect(body).toContain("ssid='NewNet'")
		expect(body).toContain("name='NewNet'")
		expect(body).toContain("passphrase='a-strong-passphrase'")
	})

	test('edit-wlan applies only requested changes', async () => {
		queueUnleashedResponse({
			xml:
				"<ajax-response><wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>" +
				"<wpa cipher='aes' passphrase='oldpass' dynamic-psk='disabled'/>" +
				'</wlansvc></ajax-response>',
		})
		await editWlan({
			name: 'Main',
			changes: { ssid: 'Main2', enabled: false },
		})
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("ssid='Main2'")
		expect(body).toContain("enable-type='1'")
	})

	test('clone-wlan reuses the source XML and renames it', async () => {
		queueUnleashedResponse({
			xml:
				"<ajax-response><wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>" +
				"<wpa cipher='aes' passphrase='secret' dynamic-psk='disabled'/>" +
				'</wlansvc></ajax-response>',
		})
		await cloneWlan({ sourceName: 'Main', newName: 'Backup' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("name='Backup'")
		expect(body).toContain("ssid='Backup'")
		expect(body).toContain("passphrase='secret'")
		expect(body).not.toMatch(/\bid='1'/)
	})

	test('delete-wlan emits delete with the resolved id', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><wlansvc id='42' name='Guest' ssid='Guest'/></ajax-response>",
		})
		await deleteWlan({ name: 'Guest' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("id='42'")
		expect(body).toContain("DELETE='true'")
	})

	test('add-wlan-group resolves member WLAN ids by name', async () => {
		queueUnleashedResponse({
			xml:
				"<ajax-response><wlansvc id='1' name='Main' ssid='Main'/>" +
				"<wlansvc id='2' name='Guest' ssid='Guest'/></ajax-response>",
		})
		await addWlanGroup({
			name: 'House',
			description: 'home',
			wlanNames: ['Main', 'Guest'],
		})
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("name='House'")
		expect(body).toContain("description='home'")
		expect(body).toContain("<wlansvc id='1'/>")
		expect(body).toContain("<wlansvc id='2'/>")
	})

	test('clone-wlan-group preserves member ids', async () => {
		queueUnleashedResponse({
			xml:
				"<ajax-response><wlangroup id='7' name='House' description='home'>" +
				"<wlansvc id='1'/><wlansvc id='2'/></wlangroup></ajax-response>",
		})
		await cloneWlanGroup({ sourceName: 'House', newName: 'Lab' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("name='Lab'")
		expect(body).toContain("<wlansvc id='1'/>")
		expect(body).toContain("<wlansvc id='2'/>")
	})

	test('delete-wlan-group emits delete with the resolved id', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><wlangroup id='7' name='House' description='home'/></ajax-response>",
		})
		await deleteWlanGroup({ name: 'House' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("id='7'")
		expect(body).toContain("DELETE='true'")
	})

	test('restart-access-point uses docmd reset on system', async () => {
		await restartAccessPoint({ mac: '24:79:DE:AD:BE:EF' })
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({ action: 'docmd', comp: 'system' })
		expect(recorded?.xmlBody).toContain("ap='24:79:de:ad:be:ef'")
		expect(recorded?.xmlBody).toContain("cmd='reset'")
	})

	test('hide-ap-leds resolves AP id and sends led-off=true', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><ap id='9' mac='24:79:de:ad:be:ef' name='Office'/></ajax-response>",
		})
		await hideApLeds({ mac: '24:79:de:ad:be:ef' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("id='9'")
		expect(body).toContain("led-off='true'")
	})

	test('show-ap-leds sends led-off=false', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><ap id='9' mac='24:79:de:ad:be:ef' name='Office'/></ajax-response>",
		})
		await showApLeds({ mac: '24:79:de:ad:be:ef' })
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("led-off='false'")
	})

	test('update-ap propagates rename, location, and ap-group id', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><ap id='9' mac='24:79:de:ad:be:ef' name='Old'/></ajax-response>",
		})
		await updateAp({
			mac: '24:79:de:ad:be:ef',
			changes: { deviceName: 'Foyer', location: 'Hall', apGroupId: '5' },
		})
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("devname='Foyer'")
		expect(body).toContain("location='Hall'")
		expect(body).toContain("apgroup-id='5'")
	})

	test('upgrade-ap-firmware uses docmd upgrade', async () => {
		await upgradeApFirmware({ mac: '24:79:de:ad:be:ef' })
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({ action: 'docmd', comp: 'system' })
		expect(recorded?.xmlBody).toContain("cmd='upgrade'")
		expect(recorded?.xmlBody).toContain("ap='24:79:de:ad:be:ef'")
	})

	test('mark-rogue-known emits a setconf known-rogue entry', async () => {
		await markRogueKnown({ mac: '11:22:33:44:55:66' })
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({ action: 'setconf', comp: 'stamgr' })
		expect(recorded?.xmlBody).toContain('known-rogue')
		expect(recorded?.xmlBody).toContain("mac='11:22:33:44:55:66'")
	})

	test('mark-rogue-blocked emits a setconf blocked-rogue entry', async () => {
		await markRogueBlocked({ mac: '11:22:33:44:55:66' })
		expect(getRecordedRequests()[0]?.xmlBody).toContain('blocked-rogue')
	})

	test('unmark-rogue deletes from both lists', async () => {
		await unmarkRogue({ mac: '11:22:33:44:55:66' })
		const body = getRecordedRequests()[0]?.xmlBody ?? ''
		expect(body).toContain('known-rogue')
		expect(body).toContain('blocked-rogue')
		expect(body.match(/DELETE='true'/g)?.length).toBe(2)
	})

	test('add-dpsk resolves the WLAN id by name', async () => {
		queueUnleashedResponse({
			xml: "<ajax-response><wlansvc id='3' name='Guest' ssid='Guest'/></ajax-response>",
		})
		await addDpsk({
			wlanName: 'Guest',
			passphrase: 'visitor-pass',
			options: { user: 'visitor' },
		})
		const body = getRecordedRequests()[1]?.xmlBody ?? ''
		expect(body).toContain("wlansvc-id='3'")
		expect(body).toContain("passphrase='visitor-pass'")
		expect(body).toContain("user='visitor'")
	})

	test('delete-dpsk emits delete with the dpsk id', async () => {
		await deleteDpsk({ id: '17' })
		const body = getRecordedRequests()[0]?.xmlBody ?? ''
		expect(body).toContain("id='17'")
		expect(body).toContain("DELETE='true'")
	})

	test('acknowledge-alarm uses docmd ack-alarm with the alarm id', async () => {
		await acknowledgeAlarm({ id: '99' })
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({ action: 'docmd', comp: 'stamgr' })
		expect(recorded?.xmlBody).toContain("cmd='ack-alarm'")
		expect(recorded?.xmlBody).toContain("id='99'")
	})

	test('clear-all-alarms uses docmd ack-alarm all=true', async () => {
		await clearAllAlarms()
		const body = getRecordedRequests()[0]?.xmlBody ?? ''
		expect(body).toContain("all='true'")
	})

	test('reboot-controller uses docmd reboot', async () => {
		await rebootController()
		const recorded = getRecordedRequests()[0]
		expect(recorded).toMatchObject({ action: 'docmd', comp: 'system' })
		expect(recorded?.xmlBody).toContain("cmd='reboot'")
	})
})

describe('safety contracts', () => {
	test('reasons that are too short are rejected before issuing the request', async () => {
		await expect(
			blockClient({ mac: 'aa:bb:cc:dd:ee:ff', reason: 'no' }),
		).rejects.toThrow('reason must be at least 20 characters')
		expect(getRecordedRequests()).toHaveLength(0)
	})

	test('every issued request includes the high-risk acknowledgement and confirmation', async () => {
		await blockClient({ mac: 'aa:bb:cc:dd:ee:ff' })
		const recorded = getRecordedRequests()[0]
		expect(recorded?.acknowledgeHighRisk).toBe(true)
		expect(recorded?.confirmation).toBe(
			'I am highly certain making this raw Access Networks Unleashed AJAX request is necessary right now.',
		)
		expect(recorded?.reason.length).toBeGreaterThanOrEqual(20)
	})
})
