/**
 * @file vitest/module.test.ts
 * @description Tests of the Homey platform against a Matter server node.
 * @author Stefan Schweiger
 */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matterbridge/Matter state.
 * Is not possible for timing reasons to create and destroy a Matter node each test to keep isolation.
 */

const NAME = 'HomeyPlatform';
const MATTER_PORT = 6200;

import { invokeBehaviorCommand, invokeSubscribeHandler, type MatterbridgeEndpoint } from 'matterbridge';
import { LogLevel } from 'matterbridge/logger';
import {
  BooleanState,
  BridgedDeviceBasicInformation,
  ColorControl,
  DoorLock,
  ElectricalPowerMeasurement,
  FanControl,
  LevelControl,
  OccupancySensing,
  OnOff,
  PowerSource,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
  Thermostat,
  WindowCovering,
} from 'matterbridge/matter/clusters';
import { flushAsync, log, loggerErrorSpy, setupTest } from 'matterbridge/vitest-utils';
import {
  addBridgedEndpoint,
  addVirtualEndpoint,
  aggregator,
  createServerNode,
  createTestEnvironment,
  destroyTestEnvironment,
  flushServerNode,
  getMatterbridge,
  removeAllBridgedEndpoints,
  removeBridgedEndpoint,
} from 'matterbridge/vitest-utils/matter';

import { HomeyBridgedDevice } from '../src/homeyDevice.js';
import { HomeyPlatform, type HomeyPlatformConfig } from '../src/module.js';
import { createDevice, FakeHomey, zones } from './fakeHomey.js';

await setupTest(NAME, false);

const ids = {
  light: '00000000-0000-4000-8000-000000000001',
  socket: '00000000-0000-4000-8000-000000000002',
  thermostat: '00000000-0000-4000-8000-000000000003',
  sensor: '00000000-0000-4000-8000-000000000004',
  cover: '00000000-0000-4000-8000-000000000005',
  lock: '00000000-0000-4000-8000-000000000006',
  fan: '00000000-0000-4000-8000-000000000007',
  remote: '00000000-0000-4000-8000-000000000008',
  hidden: '00000000-0000-4000-8000-000000000009',
  garage: '00000000-0000-4000-8000-000000000010',
};

/**
 * Wait for the fire-and-forget updates to settle
 *
 * @returns {Promise<void>} Resolves when settled.
 */
async function settle(): Promise<void> {
  await flushAsync(2, 10, 50);
}

describe('HomeyPlatform', () => {
  const homey = new FakeHomey();
  const config: HomeyPlatformConfig = {
    name: 'matterbridge-homey',
    type: 'DynamicPlatform',
    version: '1.0.0',
    address: 'http://192.168.1.50',
    token: 'api-key',
    whiteList: [],
    blackList: ['Hidden lamp'],
    zoneWhiteList: ['Home'],
    lightList: [],
    outletList: [],
    capabilityBlackList: [],
    deviceCapabilityBlackList: {},
    debug: false,
    unregisterOnShutdown: false,
  };
  let platform: HomeyPlatform;
  let selectSerials: string[] = [];

  const endpoint = (deviceId: string): MatterbridgeEndpoint => {
    const bridgedDevice = platform.bridgedDevices.get(deviceId);
    if (!bridgedDevice) throw new Error(`Device ${deviceId} not registered`);
    return bridgedDevice.endpoint;
  };

  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(MATTER_PORT);
    homey.zones = zones;
    homey.devices = [
      createDevice(ids.light, 'Color lamp', 'light', {
        onoff: false,
        dim: 0.5,
        light_hue: 0.5,
        light_saturation: 1,
        light_temperature: 0,
        light_mode: { value: 'color', values: [{ id: 'color' }, { id: 'temperature' }] },
      }),
      createDevice(ids.socket, 'Plug', 'socket', { onoff: true, measure_power: 12.5, meter_power: 3.2 }, { zone: 'zone-kitchen' }),
      createDevice(ids.thermostat, 'Radiator', 'thermostat', {
        target_temperature: { value: 20, min: 5, max: 30, step: 0.5 },
        measure_temperature: 19.5,
        thermostat_mode: { value: 'heat', values: [{ id: 'heat' }, { id: 'off' }] },
      }),
      createDevice(ids.sensor, 'Multisensor', 'sensor', {
        alarm_contact: false,
        alarm_motion: true,
        alarm_occupancy: false,
        measure_temperature: 21.3,
        measure_humidity: 45,
        measure_battery: 80,
      }),
      createDevice(ids.cover, 'Blind', 'blinds', { windowcoverings_set: 1, windowcoverings_state: 'idle' }),
      createDevice(ids.lock, 'Door', 'lock', { locked: true }),
      createDevice(ids.fan, 'Fan', 'fan', { onoff: false, fan_speed: 0.5 }),
      createDevice(ids.remote, 'Remote', 'remote', { button: { value: null } }),
      createDevice(ids.hidden, 'Hidden lamp', 'light', { onoff: false }),
      createDevice(ids.garage, 'Garage light', 'light', { onoff: false }, { zone: null }),
    ];
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await flushServerNode();
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should throw when Matterbridge is too old', () => {
    expect(() => new HomeyPlatform({ ...getMatterbridge(), matterbridgeVersion: '3.0.0' }, log, config, homey)).toThrow(/requires Matterbridge version/);
  });

  test('should throw when the address or API key is missing', () => {
    expect(() => new HomeyPlatform(getMatterbridge(), log, { ...config, token: '' })).toThrow('The Homey address and API key must be set in the configuration');
  });

  test('should register the supported and selected devices on start', async () => {
    platform = new HomeyPlatform(getMatterbridge(), log, config, homey);
    // @ts-expect-error - setMatterNode is intentionally private
    platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);
    const setSelectDevice = vi.spyOn(platform, 'setSelectDevice');
    await platform.onStart('Vitest');
    selectSerials = setSelectDevice.mock.calls.map(([serial]) => serial);

    expect(homey.connect).toHaveBeenCalledTimes(1);
    expect([...platform.bridgedDevices.keys()].toSorted()).toEqual([ids.light, ids.socket, ids.thermostat, ids.sensor, ids.cover, ids.lock, ids.fan].toSorted());
    expect(aggregator.parts.size).toBe(7);
  });

  test('should offer the registered devices in the picker with their Matter serial number', () => {
    for (const deviceId of platform.bridgedDevices.keys()) expect(selectSerials).toContain(endpoint(deviceId).serialNumber);
    expect(selectSerials).not.toContain(ids.light);
  });

  test('should link the registered devices to their page in the Homey web app', () => {
    expect(endpoint(ids.light).configUrl).toBe(`https://my.homey.app/homeys/homey-id/devices/${ids.light}`);
  });

  test('should build each device with the matching clusters', () => {
    expect(endpoint(ids.light).hasClusterServer(ColorControl)).toBe(true);
    expect(endpoint(ids.light).hasClusterServer(LevelControl)).toBe(true);
    expect(endpoint(ids.socket).hasClusterServer(OnOff)).toBe(true);
    expect(endpoint(ids.socket).hasClusterServer(ElectricalPowerMeasurement)).toBe(true);
    expect(endpoint(ids.thermostat).hasClusterServer(Thermostat)).toBe(true);
    expect(endpoint(ids.thermostat).hasClusterServer(TemperatureMeasurement)).toBe(false);
    expect(endpoint(ids.sensor).hasClusterServer(BooleanState)).toBe(true);
    expect(endpoint(ids.sensor).hasClusterServer(OccupancySensing)).toBe(true);
    expect(endpoint(ids.sensor).hasClusterServer(PowerSource)).toBe(true);
    expect(
      endpoint(ids.sensor)
        .getChildEndpoints()
        .map((child) => child.id),
    ).toEqual(['alarm_occupancy']);
    expect(endpoint(ids.cover).hasClusterServer(WindowCovering)).toBe(true);
    expect(endpoint(ids.lock).hasClusterServer(DoorLock)).toBe(true);
    expect(endpoint(ids.fan).hasClusterServer(FanControl)).toBe(true);
  });

  test('should apply the Homey state and subscribe on configure', async () => {
    await platform.onConfigure();

    expect(endpoint(ids.light).getAttribute(OnOff, 'onOff')).toBe(false);
    expect(endpoint(ids.light).getAttribute(LevelControl, 'currentLevel')).toBe(127);
    expect(endpoint(ids.light).getAttribute(ColorControl, 'currentHue')).toBe(127);
    expect(endpoint(ids.socket).getAttribute(ElectricalPowerMeasurement, 'activePower')).toBe(12500);
    expect(endpoint(ids.thermostat).getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2000);
    expect(endpoint(ids.thermostat).getAttribute(Thermostat, 'localTemperature')).toBe(1950);
    expect(endpoint(ids.thermostat).getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Heat);
    expect(endpoint(ids.sensor).getAttribute(BooleanState, 'stateValue')).toBe(true);
    expect(endpoint(ids.sensor).getAttribute(OccupancySensing, 'occupancy')).toEqual({ occupied: true });
    expect(endpoint(ids.sensor).getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(2130);
    expect(endpoint(ids.sensor).getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(4500);
    expect(endpoint(ids.sensor).getAttribute(PowerSource, 'batPercentRemaining')).toBe(160);
    expect(endpoint(ids.cover).getAttribute(WindowCovering, 'currentPositionLiftPercent100ths')).toBe(0);
    expect(endpoint(ids.lock).getAttribute(DoorLock, 'lockState')).toBe(DoorLock.LockState.Locked);
    expect(endpoint(ids.light).getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
    expect(homey.capabilityListeners.has(`${ids.sensor}/measure_humidity`)).toBe(true);
  });

  test('should send light commands to Homey', async () => {
    await invokeBehaviorCommand(endpoint(ids.light), 'onOff', 'on');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.light, 'onoff', true);

    await invokeBehaviorCommand(endpoint(ids.light), 'levelControl', 'moveToLevel', { level: 254, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.light, 'dim', 1);

    await invokeBehaviorCommand(endpoint(ids.light), 'colorControl', 'moveToHueAndSaturation', {
      hue: 254,
      saturation: 127,
      transitionTime: 0,
      optionsMask: {},
      optionsOverride: {},
    });
    expect(homey.setCapabilityValue).toHaveBeenCalledWith(ids.light, 'light_hue', 1);
    expect(homey.setCapabilityValue).toHaveBeenCalledWith(ids.light, 'light_saturation', 0.5);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.light, 'light_mode', 'color');

    await invokeBehaviorCommand(endpoint(ids.light), 'colorControl', 'moveToColorTemperature', {
      colorTemperatureMireds: 500,
      transitionTime: 0,
      optionsMask: {},
      optionsOverride: {},
    });
    expect(homey.setCapabilityValue).toHaveBeenCalledWith(ids.light, 'light_temperature', 1);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.light, 'light_mode', 'temperature');
    await settle();
  });

  test('should turn the light off when moving to the minimum level with on/off', async () => {
    await invokeBehaviorCommand(endpoint(ids.light), 'levelControl', 'moveToLevelWithOnOff', { level: 1, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
    expect(homey.setCapabilityValue).toHaveBeenCalledWith(ids.light, 'onoff', false);
    expect(homey.setCapabilityValue).not.toHaveBeenCalledWith(ids.light, 'dim', expect.anything());
    await settle();
  });

  test('should apply realtime Homey changes to Matter', async () => {
    homey.report(ids.light, 'onoff', true);
    homey.report(ids.light, 'dim', 0.25);
    homey.report(ids.sensor, 'alarm_contact', true);
    homey.report(ids.sensor, 'measure_temperature', 22);
    homey.report(ids.sensor, 'measure_battery', 5);
    homey.report(ids.socket, 'onoff', false);
    await settle();

    expect(endpoint(ids.light).getAttribute(OnOff, 'onOff')).toBe(true);
    expect(endpoint(ids.light).getAttribute(LevelControl, 'currentLevel')).toBe(64);
    expect(endpoint(ids.sensor).getAttribute(BooleanState, 'stateValue')).toBe(false);
    expect(endpoint(ids.sensor).getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(2200);
    expect(endpoint(ids.sensor).getAttribute(PowerSource, 'batChargeLevel')).toBe(PowerSource.BatChargeLevel.Critical);
    expect(endpoint(ids.socket).getAttribute(OnOff, 'onOff')).toBe(false);
  });

  test('should move the cover and report the position Homey accepted', async () => {
    await invokeBehaviorCommand(endpoint(ids.cover), 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 7500 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.cover, 'windowcoverings_set', 0.25);
    await settle();
    expect(endpoint(ids.cover).getAttribute(WindowCovering, 'currentPositionLiftPercent100ths')).toBe(7500);

    await invokeBehaviorCommand(endpoint(ids.cover), 'windowCovering', 'downOrClose');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.cover, 'windowcoverings_state', 'down');
    await settle();
  });

  test('should lock and unlock the door', async () => {
    await invokeBehaviorCommand(endpoint(ids.lock), 'doorLock', 'unlockDoor', {});
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.lock, 'locked', false);
    await invokeBehaviorCommand(endpoint(ids.lock), 'doorLock', 'lockDoor', {});
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.lock, 'locked', true);
    await settle();
  });

  test('should send thermostat setpoint and mode changes to Homey', async () => {
    await invokeSubscribeHandler(endpoint(ids.thermostat), Thermostat, 'occupiedHeatingSetpoint', 2230, 2000);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.thermostat, 'target_temperature', 22.5);

    await invokeSubscribeHandler(endpoint(ids.thermostat), Thermostat, 'systemMode', Thermostat.SystemMode.Off, Thermostat.SystemMode.Heat);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.thermostat, 'thermostat_mode', 'off');
    await settle();

    homey.report(ids.thermostat, 'thermostat_mode', 'heat');
    homey.report(ids.thermostat, 'target_temperature', 18);
    await settle();
    expect(endpoint(ids.thermostat).getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Heat);
    expect(endpoint(ids.thermostat).getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(1800);
  });

  test('should send fan speed changes to Homey', async () => {
    await invokeSubscribeHandler(endpoint(ids.fan), FanControl, 'percentSetting', 30, 0);
    expect(homey.setCapabilityValue).toHaveBeenCalledWith(ids.fan, 'fan_speed', 0.3);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.fan, 'onoff', true);
    await settle();

    await invokeSubscribeHandler(endpoint(ids.fan), FanControl, 'percentSetting', 0, 30);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith(ids.fan, 'onoff', false);
    await settle();
  });

  test('should restore the Matter state when Homey rejects a value', async () => {
    homey.report(ids.socket, 'onoff', false);
    await settle();
    // Homey answers over the network, after the Matter command completed.
    homey.setCapabilityValue.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('Device unavailable');
    });
    await invokeBehaviorCommand(endpoint(ids.socket), 'onOff', 'on');
    expect(endpoint(ids.socket).getAttribute(OnOff, 'onOff')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Device unavailable'));
    expect(endpoint(ids.socket).getAttribute(OnOff, 'onOff')).toBe(false);
  });

  test('should follow the availability of devices and of the Homey connection', async () => {
    homey.emit('device.update', { ...createDevice(ids.lock, 'Door', 'lock', { locked: true }), available: false });
    await settle();
    expect(endpoint(ids.lock).getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(false);

    homey.emit('disconnected');
    await settle();
    expect(endpoint(ids.light).getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(false);

    homey.emit('reconnected');
    await settle();
    expect(endpoint(ids.light).getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
    expect(endpoint(ids.lock).getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(false);
  });

  test('should remove a device deleted in Homey', async () => {
    homey.emit('device.delete', { id: ids.remote });
    homey.emit('device.delete', { id: ids.fan });
    await settle();
    expect(platform.bridgedDevices.has(ids.fan)).toBe(false);
    expect(homey.capabilityListeners.has(`${ids.fan}/onoff`)).toBe(false);
  });

  test('should change the logger level', async () => {
    await platform.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(endpoint(ids.sensor).log.logLevel).toBe(LogLevel.DEBUG);
    expect(endpoint(ids.sensor).getChildEndpoints()[0].log.logLevel).toBe(LogLevel.DEBUG);
  });

  test('should close the Homey connection on shutdown', async () => {
    await platform.onShutdown('Vitest');
    expect(homey.close).toHaveBeenCalledTimes(1);
    expect(homey.capabilityListeners.size).toBe(0);
    expect(platform.bridgedDevices.size).toBe(0);
  });

  test('should fail to start when Homey is not reachable', async () => {
    const unreachable = new FakeHomey();
    unreachable.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const failing = new HomeyPlatform(getMatterbridge(), log, config, unreachable);
    await expect(failing.onStart('Vitest')).rejects.toThrow('Unable to connect to Homey at http://192.168.1.50: ECONNREFUSED');
    await failing.onShutdown('Vitest');
  });

  test('should skip a device that fails to build and still start', async () => {
    const broken = new FakeHomey();
    broken.devices = [createDevice('broken', 'Broken light', 'light', { onoff: true })];
    broken.zones = zones;
    vi.spyOn(HomeyBridgedDevice, 'create').mockImplementationOnce(() => {
      throw new Error('Conformance error');
    });
    const skipping = new HomeyPlatform(getMatterbridge(), log, config, broken);
    await expect(skipping.onStart('Vitest')).resolves.toBeUndefined();
    expect(skipping.bridgedDevices.size).toBe(0);
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to register device Broken light'));
    await skipping.onShutdown('Vitest');
  });
});
