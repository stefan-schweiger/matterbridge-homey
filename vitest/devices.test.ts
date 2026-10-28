/**
 * @file vitest/devices.test.ts
 * @description Tests of the Matter devices created for the Homey device classes and capabilities.
 * @author Stefan Schweiger
 */

const NAME = 'HomeyDevices';
const MATTER_PORT = 6300;

import {
  colorTemperatureLight,
  dimmableLight,
  dimmablePlugInUnit,
  extendedColorLight,
  invokeBehaviorCommand,
  invokeSubscribeHandler,
  type MatterbridgeEndpoint,
  roboticVacuumCleaner,
} from 'matterbridge';
import {
  AirQuality,
  BooleanState,
  CarbonDioxideConcentrationMeasurement,
  ColorControl,
  ElectricalPowerMeasurement,
  FanControl,
  IlluminanceMeasurement,
  LevelControl,
  OnOff,
  Pm25ConcentrationMeasurement,
  PowerSource,
  PressureMeasurement,
  RvcCleanMode,
  RvcOperationalState,
  RvcRunMode,
  SmokeCoAlarm,
  TemperatureMeasurement,
  Thermostat,
  WindowCovering,
} from 'matterbridge/matter/clusters';
import { flushAsync } from 'matterbridge/test-utils';
import {
  getMoveToColorRequest,
  getMoveToColorTemperatureRequest,
  getMoveToHueRequest,
  getMoveToLevelRequest,
  getMoveToSaturationRequest,
  getStepRequest,
} from 'matterbridge/test-utils/matter';
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

import { getExposedCapabilities } from '../src/features.js';
import { HomeyPlatform } from '../src/module.js';
import { createDevice, FakeHomey, zones } from './fakeHomey.js';

await setupTest(NAME, false);

const modes = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));

/**
 * Convert a typed Matter request to the parameters of invokeBehaviorCommand
 *
 * @param {object} request The Matter command request.
 * @returns {Record<string, boolean | number | bigint | string | object | null>} The command parameters.
 */
function params(request: object): Record<string, boolean | number | bigint | string | object | null> {
  return Object.fromEntries(Object.entries(request));
}

const devices = [
  createDevice('dim-light', 'Dim only light', 'light', { dim: 0.4 }),
  createDevice('hs-light', 'Color only light', 'light', { onoff: false, dim: 0.5, light_hue: 0, light_saturation: 0 }),
  createDevice('ct-light', 'White light', 'light', { onoff: true, light_temperature: 0.5 }),
  createDevice('mode-light', 'Mode light', 'light', { onoff: true, dim: 1, light_hue: 0.1, light_saturation: 0.2, light_temperature: 0.3, light_mode: 'color' }),
  createDevice('aircon', 'Air conditioner', 'airconditioning', {
    'onoff': true,
    'target_temperature': { value: 24, min: 16, max: 30 },
    'measure_temperature': 26,
    'measure_temperature.outdoorTemperature': 17.5,
    'thermostat_mode': { value: 'cool', values: modes('auto', 'heat', 'cool', 'off') },
  }),
  createDevice('cooler', 'Cooler', 'airconditioning', { 'onoff': false, 'target_temperature': 22, 'measure_temperature.outside': null }),
  createDevice('fan', 'Simple fan', 'fan', { onoff: false }),
  createDevice('state-cover', 'Garage shutter', 'shutterblinds', { windowcoverings_state: 'idle' }),
  createDevice('set-cover', 'Curtain', 'curtain', { windowcoverings_set: 0 }),
  createDevice('smoke-co', 'Smoke and CO alarm', 'sensor', { alarm_smoke: false, alarm_co: false }),
  createDevice('smoke', 'Smoke alarm', 'smokealarm', { alarm_smoke: false, alarm_battery: false }),
  createDevice('co', 'CO alarm', 'sensor', { alarm_co: true }),
  createDevice('air', 'Air quality', 'sensor', { measure_co2: 600, measure_co: 1, measure_pm25: 8, measure_pm10: 12, measure_tvoc: 100 }),
  createDevice('weather', 'Weather', 'sensor', {
    'measure_pressure': 1013,
    'measure_luminance': 1000,
    'alarm_water': false,
    'measure_humidity.outside': 70,
    'alarm_contact.door2': false,
  }),
  createDevice('double', 'Double socket', 'socket', { 'onoff.output1': true, 'onoff.output2': false, 'measure_power': 5, 'measure_voltage': 230, 'measure_current': 0.1 }),
  createDevice('dim-socket', 'Dimmer socket', 'socket', { onoff: true, dim: 1 }),
  createDevice('motion', 'Motion', 'sensor', { 'alarm_motion.zone2': false, 'alarm_water.basement': false, 'measure_temperature.inside': 20 }),
  createDevice('presence', 'Presence', 'sensor', { 'onoff': true, 'alarm_presence': false, 'alarm_rain': false, 'alarm_presence.zone2': true }),
  createDevice('echo', 'Echo', 'speaker', { 'onoff.display': true, 'dim': 0.5, 'volume_set': 0.3 }),
  createDevice('split', 'Split unit', 'airconditioning', {
    onoff: true,
    target_temperature: { value: 25, min: 10, max: 30, step: 0.5 },
    thermostat_mode: { value: 'heat', values: modes('fanonly', 'heat', 'cool', 'auto', 'dry') },
  }),
  createDevice('vacuum', 'Vacuum', 'vacuumcleaner', {
    vacuumcleaner_state: 'docked',
    operational_state: 'stopped',
    vacuumcleaner_job_mode: { value: 'normal', values: modes('off', 'normal', 'turbo', 'mop') },
    measure_battery: 80,
  }),
  createDevice('onoff-vacuum', 'Simple vacuum', 'vacuumcleaner', { onoff: false }),
];

describe('Homey device mapping', () => {
  const homey = new FakeHomey();
  let platform: HomeyPlatform;

  const endpoint = (deviceId: string): MatterbridgeEndpoint => {
    const bridgedDevice = platform.bridgedDevices.get(deviceId);
    if (!bridgedDevice) throw new Error(`Device ${deviceId} not registered`);
    return bridgedDevice.endpoint;
  };
  const child = (deviceId: string, childId: string): MatterbridgeEndpoint => {
    const found = endpoint(deviceId).getChildEndpointById(childId);
    if (!found) throw new Error(`Child ${childId} of ${deviceId} not found`);
    return found;
  };
  const settle = async (): Promise<void> => flushAsync(2, 10, 50);

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
        lightList: [],
        outletList: [],
        capabilityBlackList: [],
        deviceCapabilityBlackList: {},
        newDevices: 'default',
        debug: true,
        unregisterOnShutdown: true,
      },
      homey,
    );
    // @ts-expect-error - setMatterNode is intentionally private
    platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);
    await platform.onStart('Vitest');
    await platform.onConfigure();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await platform.onShutdown('Vitest');
    await flushServerNode();
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should register all the devices', () => {
    expect(platform.bridgedDevices.size).toBe(devices.length - 1);
    expect(platform.bridgedDevices.has('echo')).toBe(false);
    expect(endpoint('dim-light').deviceTypes.has(dimmableLight.code)).toBe(true);
    expect(endpoint('hs-light').deviceTypes.has(extendedColorLight.code)).toBe(true);
    expect(endpoint('ct-light').deviceTypes.has(colorTemperatureLight.code)).toBe(true);
    expect(endpoint('dim-socket').deviceTypes.has(dimmablePlugInUnit.code)).toBe(true);
  });

  test('should offer every capability a device uses in the capability pickers', () => {
    for (const bridgedDevice of platform.bridgedDevices.values()) {
      const exposed = getExposedCapabilities(bridgedDevice.device);
      expect(bridgedDevice.capabilityIds.filter((capabilityId) => !exposed.includes(capabilityId))).toEqual([]);
    }
  });

  test('should control a light that only has dim', async () => {
    await invokeBehaviorCommand(endpoint('dim-light'), 'onOff', 'off');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('dim-light', 'dim', 0);
    await invokeBehaviorCommand(endpoint('dim-light'), 'onOff', 'on');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('dim-light', 'dim', 0.4);
    homey.report('dim-light', 'dim', 0);
    await settle();
    expect(endpoint('dim-light').getAttribute(OnOff, 'onOff')).toBe(false);
  });

  test('should control a color light without white temperature', async () => {
    const light = endpoint('hs-light');
    await invokeBehaviorCommand(light, 'onOff', 'toggle');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'onoff', true);
    await invokeBehaviorCommand(light, 'levelControl', 'LevelControl.step', params(getStepRequest(LevelControl.StepMode.Down, 27, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'dim', 0.39);
    await invokeBehaviorCommand(light, 'levelControl', 'LevelControl.stepWithOnOff', params(getStepRequest(LevelControl.StepMode.Up, 254, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenCalledWith('hs-light', 'dim', 1);
    await invokeBehaviorCommand(light, 'colorControl', 'moveToHue', params(getMoveToHueRequest(127, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'light_hue', 0.5);
    await invokeBehaviorCommand(light, 'colorControl', 'moveToSaturation', params(getMoveToSaturationRequest(254, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'light_saturation', 1);
    await invokeBehaviorCommand(light, 'colorControl', 'moveToColor', params(getMoveToColorRequest(45000, 19000, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenCalledWith('hs-light', 'light_hue', expect.any(Number));
    await invokeBehaviorCommand(light, 'colorControl', 'moveToColorTemperature', params(getMoveToColorTemperatureRequest(400, 0, true)));
    expect(homey.setCapabilityValue).not.toHaveBeenCalledWith('hs-light', 'light_temperature', expect.anything());
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'light_saturation', expect.any(Number));
    await settle();

    homey.report('hs-light', 'light_hue', 0.25);
    homey.report('hs-light', 'light_saturation', 0.5);
    await settle();
    expect(light.getAttribute(ColorControl, 'currentHue')).toBe(64);
    await vi.waitFor(() => expect(light.getAttribute(ColorControl, 'colorMode')).toBe(ColorControl.ColorMode.CurrentHueAndCurrentSaturation));
  });

  test('should turn on a light that is off when moving to a level with on/off', async () => {
    homey.report('hs-light', 'onoff', false);
    await settle();
    await invokeBehaviorCommand(endpoint('hs-light'), 'levelControl', 'moveToLevelWithOnOff', params(getMoveToLevelRequest(127, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenCalledWith('hs-light', 'dim', 0.5);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('hs-light', 'onoff', true);
    await settle();
  });

  test('should control a white light', async () => {
    await invokeBehaviorCommand(endpoint('ct-light'), 'colorControl', 'moveToColorTemperature', params(getMoveToColorTemperatureRequest(153, 0, true)));
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('ct-light', 'light_temperature', 0);
    homey.report('ct-light', 'light_temperature', 1);
    await settle();
    expect(endpoint('ct-light').getAttribute(ColorControl, 'colorTemperatureMireds')).toBe(500);
  });

  test('should follow the Homey light mode', async () => {
    const light = endpoint('mode-light');
    homey.report('mode-light', 'light_mode', 'temperature');
    await settle();
    expect(light.getAttribute(ColorControl, 'colorMode')).toBe(ColorControl.ColorMode.ColorTemperatureMireds);
    homey.report('mode-light', 'light_hue', 0.5);
    homey.report('mode-light', 'light_temperature', 0);
    await settle();
    expect(light.getAttribute(ColorControl, 'colorMode')).toBe(ColorControl.ColorMode.ColorTemperatureMireds);
    expect(light.getAttribute(ColorControl, 'colorTemperatureMireds')).toBe(153);
    homey.report('mode-light', 'light_mode', 'color');
    homey.report('mode-light', 'light_saturation', 1);
    await settle();
    expect(light.getAttribute(ColorControl, 'colorMode')).toBe(ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
  });

  test('should control an air conditioner with modes', async () => {
    const aircon = endpoint('aircon');
    expect(aircon.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Cool);
    // The outdoor temperature is part of the thermostat, not an unnamed child device.
    expect(aircon.getChildEndpoints()).toHaveLength(0);
    expect(aircon.getAttribute(Thermostat, 'outdoorTemperature')).toBe(1750);
    homey.report('aircon', 'measure_temperature.outdoorTemperature', 12);
    await settle();
    expect(aircon.getAttribute(Thermostat, 'outdoorTemperature')).toBe(1200);
    await invokeSubscribeHandler(aircon, Thermostat, 'occupiedCoolingSetpoint', 2100, 2400);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('aircon', 'target_temperature', 21);
    await invokeSubscribeHandler(aircon, Thermostat, 'systemMode', Thermostat.SystemMode.Heat, Thermostat.SystemMode.Cool);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('aircon', 'thermostat_mode', 'heat');
    await settle();
    // Off switches onoff, not the off mode, and keeps the mode for the next time it's switched on.
    await invokeSubscribeHandler(aircon, Thermostat, 'systemMode', Thermostat.SystemMode.Off, Thermostat.SystemMode.Heat);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('aircon', 'onoff', false);
    expect(homey.setCapabilityValue).not.toHaveBeenCalledWith('aircon', 'thermostat_mode', 'off');
    await settle();

    homey.report('aircon', 'onoff', false);
    await settle();
    expect(aircon.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Off);
    await invokeSubscribeHandler(aircon, Thermostat, 'systemMode', Thermostat.SystemMode.Auto, Thermostat.SystemMode.Off);
    expect(homey.setCapabilityValue).toHaveBeenCalledWith('aircon', 'thermostat_mode', 'auto');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('aircon', 'onoff', true);
    homey.report('aircon', 'measure_temperature', 25.5);
    homey.report('aircon', 'target_temperature', 23);
    await settle();
    expect(aircon.getAttribute(Thermostat, 'localTemperature')).toBe(2550);
    expect(aircon.getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2300);
    expect(aircon.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2300);
  });

  test('should switch a cooler without modes with onoff', async () => {
    const cooler = endpoint('cooler');
    expect(cooler.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Off);
    expect(cooler.getAttribute(Thermostat, 'outdoorTemperature')).toBeNull();
    await invokeSubscribeHandler(cooler, Thermostat, 'systemMode', Thermostat.SystemMode.Cool, Thermostat.SystemMode.Off);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('cooler', 'onoff', true);
    await settle();
    await invokeSubscribeHandler(cooler, Thermostat, 'systemMode', Thermostat.SystemMode.Off, Thermostat.SystemMode.Cool);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('cooler', 'onoff', false);
    await settle();
  });

  test('should switch a fan without speed', async () => {
    await invokeSubscribeHandler(endpoint('fan'), FanControl, 'percentSetting', 100, 0);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('fan', 'onoff', true);
    await settle();
    expect(endpoint('fan').getAttribute(FanControl, 'percentCurrent')).toBe(100);
  });

  test('should control a cover that only reports its movement', async () => {
    const cover = endpoint('state-cover');
    await invokeBehaviorCommand(cover, 'windowCovering', 'upOrOpen');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('state-cover', 'windowcoverings_state', 'up');
    await settle();
    expect(cover.getAttribute(WindowCovering, 'operationalStatus')?.global).toBe(WindowCovering.MovementStatus.Opening);
    await invokeBehaviorCommand(cover, 'windowCovering', 'stopMotion');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('state-cover', 'windowcoverings_state', 'idle');
    await invokeBehaviorCommand(cover, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 10000 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('state-cover', 'windowcoverings_state', 'down');
    await settle();
    homey.report('state-cover', 'windowcoverings_state', 'idle');
    await settle();
    expect(cover.getAttribute(WindowCovering, 'operationalStatus')?.global).toBe(WindowCovering.MovementStatus.Stopped);
  });

  test('should open and close a cover that only has a position', async () => {
    await invokeBehaviorCommand(endpoint('set-cover'), 'windowCovering', 'upOrOpen');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('set-cover', 'windowcoverings_set', 1);
    await settle();
    await invokeBehaviorCommand(endpoint('set-cover'), 'windowCovering', 'downOrClose');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('set-cover', 'windowcoverings_set', 0);
    await invokeBehaviorCommand(endpoint('set-cover'), 'windowCovering', 'stopMotion');
    await settle();
    expect(endpoint('set-cover').getAttribute(WindowCovering, 'currentPositionLiftPercent100ths')).toBe(10000);
  });

  test('should report smoke and CO alarms', async () => {
    homey.report('smoke-co', 'alarm_smoke', true);
    homey.report('smoke-co', 'alarm_co', true);
    homey.report('smoke', 'alarm_battery', true);
    await settle();
    expect(endpoint('smoke-co').getAttribute(SmokeCoAlarm, 'smokeState')).toBe(SmokeCoAlarm.AlarmState.Critical);
    expect(endpoint('smoke-co').getAttribute(SmokeCoAlarm, 'coState')).toBe(SmokeCoAlarm.AlarmState.Critical);
    expect(endpoint('smoke').getAttribute(PowerSource, 'batChargeLevel')).toBe(PowerSource.BatChargeLevel.Critical);
    expect(endpoint('co').getAttribute(SmokeCoAlarm, 'coState')).toBe(SmokeCoAlarm.AlarmState.Critical);
  });

  test('should report air quality, weather and electrical measurements', async () => {
    expect(endpoint('air').getAttribute(AirQuality, 'airQuality')).toBe(AirQuality.AirQualityEnum.Unknown);
    homey.report('air', 'measure_co2', 800);
    homey.report('air', 'measure_pm25', 15);
    homey.report('weather', 'measure_pressure', 1000.4);
    homey.report('weather', 'measure_luminance', 100);
    homey.report('weather', 'alarm_water', true);
    homey.report('double', 'measure_voltage', 231);
    homey.report('double', 'measure_current', 0.5);
    await settle();
    expect(endpoint('air').getAttribute(CarbonDioxideConcentrationMeasurement, 'measuredValue')).toBe(800);
    expect(endpoint('air').getAttribute(Pm25ConcentrationMeasurement, 'measuredValue')).toBe(15);
    expect(endpoint('weather').getAttribute(PressureMeasurement, 'measuredValue')).toBe(1000);
    expect(endpoint('weather').getAttribute(IlluminanceMeasurement, 'measuredValue')).toBe(20001);
    expect(endpoint('weather').getAttribute(BooleanState, 'stateValue')).toBe(true);
    expect(endpoint('double').getAttribute(ElectricalPowerMeasurement, 'voltage')).toBe(231000);
    expect(endpoint('double').getAttribute(ElectricalPowerMeasurement, 'activeCurrent')).toBe(500);
  });

  test('should expose sub-capabilities as child endpoints', async () => {
    await invokeBehaviorCommand(child('double', 'onoffoutput2'), 'onOff', 'on');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('double', 'onoff.output2', true);
    await invokeBehaviorCommand(endpoint('double'), 'onOff', 'off');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('double', 'onoff.output1', false);
    homey.report('weather', 'measure_humidity.outside', 71);
    homey.report('motion', 'measure_temperature.inside', 21);
    await settle();
    expect(child('weather', 'measure_humidityoutside').getAttribute('RelativeHumidityMeasurement', 'measuredValue')).toBe(7100);
    expect(child('weather', 'alarm_contactdoor2').getAttribute(BooleanState, 'stateValue')).toBe(true);
    expect(endpoint('motion').getAttribute('OccupancySensing', 'occupancy')).toEqual({ occupied: false });
    expect(child('motion', 'measure_temperatureinside').getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(2100);
  });

  test('should expose presence and rain sensors but not the display switch of a sensor', async () => {
    const presence = endpoint('presence');
    expect(presence.hasClusterServer(OnOff)).toBe(false);
    expect(child('presence', 'alarm_presencezone2').getAttribute('OccupancySensing', 'occupancy')).toEqual({ occupied: true });
    homey.report('presence', 'alarm_presence', true);
    homey.report('presence', 'alarm_rain', true);
    await settle();
    expect(presence.getAttribute('OccupancySensing', 'occupancy')).toEqual({ occupied: true });
    expect(presence.getAttribute(BooleanState, 'stateValue')).toBe(true);
  });

  test('should map the dry and fan only modes of an air conditioner', async () => {
    const split = endpoint('split');
    homey.report('split', 'thermostat_mode', 'dry');
    await settle();
    expect(split.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Dry);
    await invokeSubscribeHandler(split, Thermostat, 'systemMode', Thermostat.SystemMode.FanOnly, Thermostat.SystemMode.Dry);
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('split', 'thermostat_mode', 'fanonly');
    await settle();
  });

  test('should control a vacuum with the standard vacuum capabilities', async () => {
    const vacuum = endpoint('vacuum');
    const { OperationalState } = RvcOperationalState;
    expect(vacuum.deviceTypes.has(roboticVacuumCleaner.code)).toBe(true);
    expect(vacuum.hasClusterServer(PowerSource)).toBe(true);
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Docked);
    expect(vacuum.getAttribute(RvcRunMode, 'currentMode')).toBe(1);
    expect(vacuum.getAttribute(RvcCleanMode, 'supportedModes')?.map((mode: RvcCleanMode.ModeOption) => mode.label)).toEqual(['Normal', 'Turbo', 'Mop']);

    await invokeBehaviorCommand(vacuum, 'rvcCleanMode', 'changeToMode', { newMode: 4 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('vacuum', 'vacuumcleaner_job_mode', 'mop');
    await invokeBehaviorCommand(vacuum, 'rvcRunMode', 'changeToMode', { newMode: 2 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('vacuum', 'vacuumcleaner_state', 'cleaning');
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Running);
    expect(vacuum.getAttribute(RvcCleanMode, 'currentMode')).toBe(4);
    // Matter doesn't change the clean mode while the vacuum cleans.
    await invokeBehaviorCommand(vacuum, 'rvcCleanMode', 'changeToMode', { newMode: 1 });
    expect(homey.setCapabilityValue).not.toHaveBeenCalledWith('vacuum', 'vacuumcleaner_job_mode', 'normal');

    await invokeBehaviorCommand(vacuum, 'rvcOperationalState', 'pause');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('vacuum', 'vacuumcleaner_state', 'stopped');
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Paused);
    await invokeBehaviorCommand(vacuum, 'rvcOperationalState', 'resume');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('vacuum', 'vacuumcleaner_state', 'cleaning');
    await settle();
    await invokeBehaviorCommand(vacuum, 'rvcOperationalState', 'goHome');
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('vacuum', 'vacuumcleaner_state', 'docked');
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Docked);
    expect(vacuum.getAttribute(RvcRunMode, 'currentMode')).toBe(1);
    // A docked vacuum can't be paused or resumed.
    homey.setCapabilityValue.mockClear();
    await invokeBehaviorCommand(vacuum, 'rvcOperationalState', 'pause');
    await invokeBehaviorCommand(vacuum, 'rvcOperationalState', 'resume');
    expect(homey.setCapabilityValue).not.toHaveBeenCalled();

    homey.report('vacuum', 'vacuumcleaner_state', 'charging');
    homey.report('vacuum', 'vacuumcleaner_job_mode', 'off');
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Charging);
    expect(vacuum.getAttribute(RvcCleanMode, 'currentMode')).toBe(1);
    homey.report('vacuum', 'operational_state', 'error');
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Error);
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalError')?.errorStateId).toBe(RvcOperationalState.ErrorState.UnableToCompleteOperation);
  });

  test('should start and stop a vacuum that only has onoff', async () => {
    const vacuum = endpoint('onoff-vacuum');
    const { OperationalState } = RvcOperationalState;
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Stopped);
    expect(vacuum.hasClusterServer(RvcCleanMode)).toBe(false);
    await invokeBehaviorCommand(vacuum, 'rvcRunMode', 'changeToMode', { newMode: 2 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('onoff-vacuum', 'onoff', true);
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Running);
    await invokeBehaviorCommand(vacuum, 'rvcRunMode', 'changeToMode', { newMode: 1 });
    expect(homey.setCapabilityValue).toHaveBeenLastCalledWith('onoff-vacuum', 'onoff', false);
    await settle();
    expect(vacuum.getAttribute(RvcOperationalState, 'operationalState')).toBe(OperationalState.Stopped);
    expect(vacuum.getAttribute(RvcRunMode, 'currentMode')).toBe(1);
  });
});
