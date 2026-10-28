/**
 * @file vitest/newDevices.test.ts
 * @description Tests that the newDevices setting adds the devices added to Homey to the white or black list.
 * @author Stefan Schweiger
 */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially: the plugin storage remembers the devices seen by the previous tests.
 */

const NAME = 'HomeyNewDevices';
const MATTER_PORT = 6700;

import { flushAsync } from 'matterbridge/test-utils';
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
} from 'matterbridge/test-utils/vitest/matter';
import { log, setupTest } from 'matterbridge/test-utils/vitest/setup';

import type { HomeyDevice } from '../src/homey.js';
import { HomeyPlatform, type HomeyPlatformConfig } from '../src/module.js';
import { createDevice, FakeHomey, zones } from './fakeHomey.js';

await setupTest(NAME, false);

const lamp = createDevice('00000000-0000-4000-8000-0000000000c1', 'Lamp', 'light', { onoff: true });
const plug = createDevice('00000000-0000-4000-8000-0000000000c2', 'Plug', 'socket', { onoff: false });
const heater = createDevice('00000000-0000-4000-8000-0000000000c3', 'Heater', 'socket', { onoff: false });
const fan = createDevice('00000000-0000-4000-8000-0000000000c4', 'Fan', 'fan', { onoff: false });
const desk = createDevice('00000000-0000-4000-8000-0000000000c5', 'Desk lamp', 'light', { onoff: false });

/**
 * Start Matterbridge (a server node on the same storage) with the plugin and the given devices
 *
 * @param {HomeyPlatformConfig['newDevices']} newDevices The newDevices setting.
 * @param {HomeyDevice[]} devices The Homey devices.
 * @param {Partial<HomeyPlatformConfig>} [lists] The white and black lists.
 * @returns {Promise<{ homey: FakeHomey; platform: HomeyPlatform }>} The running plugin.
 */
async function start(
  newDevices: HomeyPlatformConfig['newDevices'],
  devices: HomeyDevice[],
  lists: Partial<HomeyPlatformConfig> = {},
): Promise<{ homey: FakeHomey; platform: HomeyPlatform }> {
  await createServerNode(MATTER_PORT);
  const homey = new FakeHomey();
  homey.zones = zones;
  homey.devices = [...devices];
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
      newDevices,
      debug: false,
      unregisterOnShutdown: false,
      ...lists,
    },
    homey,
  );
  // @ts-expect-error - setMatterNode is intentionally private
  platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);
  await platform.onStart('Vitest');
  await platform.onConfigure();
  return { homey, platform };
}

/**
 * Stop Matterbridge
 *
 * @param {HomeyPlatform} platform The running plugin.
 * @returns {Promise<void>} Resolves when stopped.
 */
async function stop(platform: HomeyPlatform): Promise<void> {
  await platform.onShutdown('Vitest');
  await flushServerNode();
}

/**
 * Add a device to Homey while the plugin runs
 *
 * @param {FakeHomey} homey The fake Homey.
 * @param {HomeyDevice} device The new device.
 * @returns {Promise<void>} Resolves when the plugin handled the device.
 */
async function create(homey: FakeHomey, device: HomeyDevice): Promise<void> {
  homey.devices.push(device);
  homey.emit('device.create', device);
  await flushAsync(2, 10, 50);
}

describe('New Homey devices', () => {
  beforeAll(async () => {
    await createTestEnvironment();
  });

  afterAll(async () => {
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should add a new device to the black list and not expose it when newDevices is blackList', async () => {
    const { homey, platform } = await start('blackList', [lamp]);
    // On the first start, all the devices are known.
    expect(platform.config.blackList).toEqual([]);
    expect(platform.bridgedDevices.has(lamp.id)).toBe(true);

    const saveConfig = vi.spyOn(platform, 'saveConfig');
    await create(homey, plug);
    expect(platform.config.blackList).toEqual(['Plug']);
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ blackList: ['Plug'] }));
    expect(platform.bridgedDevices.has(plug.id)).toBe(false);
    await stop(platform);
  });

  test('should treat a device added while Matterbridge was stopped as new', async () => {
    const { platform } = await start('blackList', [lamp, plug, heater], { blackList: ['Plug'] });
    expect(platform.config.blackList).toEqual(['Plug', 'Heater']);
    expect([...platform.bridgedDevices.keys()]).toEqual([lamp.id]);
    await stop(platform);
  });

  test('should add a new device to the white list and expose it when newDevices is whiteList', async () => {
    const { homey, platform } = await start('whiteList', [lamp, plug, heater], { whiteList: ['Lamp'] });
    await create(homey, fan);
    expect(platform.config.whiteList).toEqual(['Lamp', 'Fan']);
    expect(platform.bridgedDevices.has(fan.id)).toBe(true);
    await stop(platform);
  });

  test('should not fill an empty white list, which exposes all the devices', async () => {
    const { homey, platform } = await start('whiteList', [lamp, plug, heater, fan]);
    await create(homey, desk);
    expect(platform.config.whiteList).toEqual([]);
    expect(platform.bridgedDevices.has(desk.id)).toBe(true);
    await stop(platform);
  });
});
