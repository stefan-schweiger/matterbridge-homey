/**
 * @file vitest/customize.test.ts
 * @description Tests of the settings that remap device types and exclude capabilities.
 * @author Stefan Schweiger
 */

const NAME = 'HomeyCustomize';
const MATTER_PORT = 6600;

import { onOffLight, onOffPlugInUnit, type MatterbridgeEndpoint } from 'matterbridge';
import { ElectricalEnergyMeasurement, OccupancySensing, RelativeHumidityMeasurement, Thermostat } from 'matterbridge/matter/clusters';
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

import { getSerialNumber } from '../src/homeyDevice.js';
import { HomeyPlatform } from '../src/module.js';
import { createDevice, FakeHomey, zones } from './fakeHomey.js';

await setupTest(NAME, false);

const lampId = '00000000-0000-4000-8000-0000000000c1';
const devices = [
  createDevice('fan-button', 'Lüftung', 'button', { 'onoff': false, 'button.repair': null }),
  createDevice(lampId, 'Lamp', 'light', { onoff: true }),
  createDevice('aircon', 'AC', 'airconditioning', { 'onoff': true, 'target_temperature': 22, 'meter_power': 120, 'measure_temperature.outdoorTemperature': 15 }),
  createDevice('multi', 'Multisensor', 'sensor', { 'alarm_motion': false, 'alarm_occupancy': true, 'measure_humidity': 50, 'measure_battery': 90, 'button.repair': null }),
  createDevice('humidity', 'Only humidity', 'sensor', { measure_humidity: 40 }),
];

describe('Remapping devices and excluding capabilities', () => {
  const homey = new FakeHomey();
  let platform: HomeyPlatform;
  let selectDevices: Parameters<HomeyPlatform['setSelectDevice']>[] = [];
  let selectEntities: string[] = [];

  const endpoint = (deviceId: string): MatterbridgeEndpoint => {
    const bridgedDevice = platform.bridgedDevices.get(deviceId);
    if (!bridgedDevice) throw new Error(`Device ${deviceId} not registered`);
    return bridgedDevice.endpoint;
  };

  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(MATTER_PORT);
    homey.devices = devices;
    homey.zones = zones;
    platform = new HomeyPlatform(
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
        lightList: ['Lüftung'],
        outletList: [getSerialNumber(lampId)],
        capabilityBlackList: ['meter_power'],
        deviceCapabilityBlackList: { Multisensor: ['alarm_occupancy'], humidity: ['measure_humidity'] },
        newDevices: 'default',
        debug: false,
        unregisterOnShutdown: false,
      },
      homey,
    );
    // @ts-expect-error - setMatterNode is intentionally private
    platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);
    const setSelectDevice = vi.spyOn(platform, 'setSelectDevice');
    const setSelectEntity = vi.spyOn(platform, 'setSelectEntity');
    await platform.onStart('Vitest');
    await platform.onConfigure();
    selectDevices = setSelectDevice.mock.calls;
    selectEntities = setSelectEntity.mock.calls.map(([name]) => name);
  });

  afterAll(async () => {
    await platform.onShutdown('Vitest');
    await flushServerNode();
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should expose the devices in the light and outlet lists with that device type', () => {
    expect(endpoint('fan-button').deviceTypes.has(onOffLight.code)).toBe(true);
    expect(endpoint(lampId).deviceTypes.has(onOffPlugInUnit.code)).toBe(true);
    expect(endpoint(lampId).deviceTypes.has(onOffLight.code)).toBe(false);
  });

  test('should exclude the capabilities of the black lists', () => {
    expect(endpoint('aircon').hasClusterServer(ElectricalEnergyMeasurement)).toBe(false);
    expect(endpoint('aircon').getAttribute(Thermostat, 'outdoorTemperature')).toBe(1500);
    expect(homey.capabilityListeners.has('aircon/meter_power')).toBe(false);
    expect(endpoint('multi').getChildEndpoints()).toHaveLength(0);
    expect(endpoint('multi').hasClusterServer(OccupancySensing)).toBe(true);
    expect(endpoint('multi').hasClusterServer(RelativeHumidityMeasurement)).toBe(true);
    expect(homey.capabilityListeners.has('multi/alarm_occupancy')).toBe(false);
  });

  test('should skip a device without capabilities after the black lists', () => {
    expect(platform.bridgedDevices.has('humidity')).toBe(false);
    expect(platform.bridgedDevices.size).toBe(4);
  });

  test('should offer the exposed capabilities, including the excluded ones, in the pickers', () => {
    const multi = selectDevices.find(([, name]) => name === 'Multisensor');
    expect(multi?.[4]?.map((entity) => entity.name)).toEqual(['alarm_motion', 'alarm_occupancy', 'measure_humidity', 'measure_battery']);
    expect(selectDevices.some(([, name]) => name === 'Only humidity')).toBe(true);
    expect(selectEntities).toContain('meter_power');
    expect(selectEntities).toContain('measure_temperature.outdoorTemperature');
    expect(selectEntities).not.toContain('button.repair');
  });
});
