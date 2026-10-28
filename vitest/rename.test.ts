/**
 * @file vitest/rename.test.ts
 * @description Tests that a device renamed in Homey keeps its Matter identity and shows its new name.
 * @author Stefan Schweiger
 */

const NAME = 'HomeyRename';
const MATTER_PORT = 6500;

import type { MatterbridgeEndpoint } from 'matterbridge';
import { BridgedDeviceBasicInformation } from 'matterbridge/matter/clusters';
import { log, setupTest } from 'matterbridge/vitest-utils';
import {
  addBridgedEndpoint,
  addVirtualEndpoint,
  createServerNode,
  createTestEnvironment,
  destroyTestEnvironment,
  flushServerNode,
  getMatterbridge,
  removeAllBridgedEndpoints,
  removeBridgedEndpoint,
} from 'matterbridge/vitest-utils/matter';

import { createStableUniqueId } from '../src/homeyDevice.js';
import { HomeyPlatform } from '../src/module.js';
import { createDevice, FakeHomey, zones } from './fakeHomey.js';

await setupTest(NAME, false);

const lampId = '00000000-0000-4000-8000-0000000000aa';
const plugId = '00000000-0000-4000-8000-0000000000bb';

/**
 * Start Matterbridge (a server node on the same storage) with the plugin and the given devices
 *
 * @param {string} lampName The name of the lamp in Homey.
 * @returns {Promise<{ homey: FakeHomey; platform: HomeyPlatform; lamp: MatterbridgeEndpoint; plug: MatterbridgeEndpoint }>} The running plugin.
 */
async function start(lampName: string): Promise<{ homey: FakeHomey; platform: HomeyPlatform; lamp: MatterbridgeEndpoint; plug: MatterbridgeEndpoint }> {
  await createServerNode(MATTER_PORT);
  const homey = new FakeHomey();
  homey.zones = zones;
  homey.devices = [
    createDevice(lampId, lampName, 'light', { onoff: true }, { zone: 'zone-living' }),
    createDevice(plugId, 'Plug', 'socket', { onoff: false }, { zone: 'zone-kitchen' }),
  ];
  const platform = new HomeyPlatform(
    getMatterbridge(),
    log,
    {
      name: 'matterbridge-homey',
      type: 'DynamicPlatform',
      version: '1.0.0',
      address: 'http://homey',
      token: 'key',
      whiteList: [],
      blackList: [],
      zoneWhiteList: [],
      lightList: [],
      outletList: [],
      capabilityBlackList: [],
      deviceCapabilityBlackList: {},
      exposeNewDevices: true,
      debug: false,
      unregisterOnShutdown: false,
    },
    homey,
  );
  // @ts-expect-error - setMatterNode is intentionally private
  platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);
  await platform.onStart('Vitest');
  await platform.onConfigure();
  const endpoint = (deviceId: string): MatterbridgeEndpoint => {
    const bridgedDevice = platform.bridgedDevices.get(deviceId);
    if (!bridgedDevice) throw new Error(`Device ${deviceId} not registered`);
    return bridgedDevice.endpoint;
  };
  return { homey, platform, lamp: endpoint(lampId), plug: endpoint(plugId) };
}

describe('Renaming a Homey device', () => {
  beforeAll(async () => {
    await createTestEnvironment();
  });

  afterAll(async () => {
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should keep the Matter identity and show the new name after a restart and live', async () => {
    const first = await start('Lamp');
    const endpointNumber = first.lamp.number;
    expect(first.lamp.getAttribute(BridgedDeviceBasicInformation, 'nodeLabel')).toBe('Lamp');
    expect(first.lamp.getAttribute(BridgedDeviceBasicInformation, 'uniqueId')).toBe(createStableUniqueId(lampId));
    expect(first.lamp.uniqueId).toBe(createStableUniqueId(lampId));
    await first.platform.onShutdown('Vitest');
    await flushServerNode();

    // Renamed in Homey while Matterbridge was stopped.
    const second = await start('Desk lamp');
    expect(second.lamp.number).toBe(endpointNumber);
    expect(second.lamp.getAttribute(BridgedDeviceBasicInformation, 'uniqueId')).toBe(createStableUniqueId(lampId));
    expect(second.lamp.getAttribute(BridgedDeviceBasicInformation, 'nodeLabel')).toBe('Desk lamp');

    // Renamed in Homey while Matterbridge runs. homey-api updates its device objects in place.
    second.homey.devices[0].name = 'Reading lamp';
    second.homey.emit('device.update', second.homey.devices[0]);
    await vi.waitFor(() => expect(second.lamp.getAttribute(BridgedDeviceBasicInformation, 'nodeLabel')).toBe('Reading lamp'));
    expect(second.lamp.deviceName).toBe('Reading lamp');
    expect(second.lamp.getAttribute(BridgedDeviceBasicInformation, 'uniqueId')).toBe(createStableUniqueId(lampId));

    // A rename to a name that exists in another zone gives both devices their zone suffix.
    second.homey.devices[1].name = 'Reading lamp';
    second.homey.emit('device.update', second.homey.devices[1]);
    await vi.waitFor(() => expect(second.plug.getAttribute(BridgedDeviceBasicInformation, 'nodeLabel')).toBe('Reading lamp Kitchen'));
    expect(second.lamp.getAttribute(BridgedDeviceBasicInformation, 'nodeLabel')).toBe('Reading lamp Living room');

    await second.platform.onShutdown('Vitest');
    await flushServerNode();
  });
});
