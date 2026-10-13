/**
 * @file vitest/features.test.ts
 * @description Tests of the mapping of Homey devices to Matter features.
 * @author Stefan Schweiger
 */

import { colorTemperatureLight, dimmableLight, extendedColorLight, onOffLight, onOffPlugInUnit, thermostat } from 'matterbridge';

import { getDeviceClass, getExposedCapabilities, planFeatures } from '../src/features.js';
import { splitFeatures } from '../src/homeyDevice.js';
import { getUniqueDeviceNames, isInZones } from '../src/module.js';
import { createDevice, zones } from './fakeHomey.js';

describe('planFeatures', () => {
  test('should pick the light device type from the light capabilities', () => {
    expect(planFeatures(createDevice('1', 'Light', 'light', { onoff: true }))[0].deviceTypes).toEqual([onOffLight]);
    expect(planFeatures(createDevice('1', 'Light', 'light', { onoff: true, dim: 1 }))[0].deviceTypes).toEqual([dimmableLight]);
    expect(planFeatures(createDevice('1', 'Light', 'light', { onoff: true, dim: 1, light_temperature: 0.5 }))[0].deviceTypes).toEqual([colorTemperatureLight]);
    expect(planFeatures(createDevice('1', 'Light', 'light', { onoff: true, dim: 1, light_hue: 0, light_saturation: 0 }))[0].deviceTypes).toEqual([extendedColorLight]);
  });

  test('should use the virtual class when the user changed it', () => {
    const device = createDevice('1', 'Socket as light', 'socket', { onoff: true }, { virtualClass: 'light' });
    expect(getDeviceClass(device)).toBe('light');
    expect(planFeatures(device)[0].deviceTypes).toEqual([onOffLight]);
  });

  test('should expose unknown classes with onoff as a plug', () => {
    expect(planFeatures(createDevice('1', 'Kettle', 'kettle', { onoff: false }))[0].deviceTypes).toEqual([onOffPlugInUnit]);
  });

  test('should list the capabilities a device exposes', () => {
    const device = createDevice('1', 'Light', 'light', { 'button.repair': null, 'onoff': true, 'dim': 1, 'measure_power': 5, 'measure_battery': 50 });
    expect(getExposedCapabilities(device)).toEqual(['onoff', 'dim', 'measure_power', 'measure_battery']);
    expect(getExposedCapabilities(createDevice('2', 'Battery only', 'other', { measure_battery: 50 }))).toEqual([]);
  });

  test('should return no features when nothing can be exposed', () => {
    expect(planFeatures(createDevice('1', 'Remote', 'remote', { button: { value: null } }))).toEqual([]);
    expect(planFeatures(createDevice('1', 'Battery only', 'other', { measure_battery: 50 }))).toEqual([]);
  });

  test('should use the thermostat local temperature instead of a temperature sensor', () => {
    const features = planFeatures(createDevice('1', 'Thermostat', 'thermostat', { target_temperature: 21, measure_temperature: 20, measure_humidity: 40 }));
    expect(features.map((feature) => feature.name)).toEqual(['thermostat', 'measure_humidity']);
    expect(features[0].deviceTypes).toEqual([thermostat]);
  });

  test('should report the outdoor temperature of an air conditioner on the thermostat', () => {
    const device = createDevice('1', 'AC', 'airconditioning', {
      'onoff': true,
      'target_temperature': 22,
      'measure_temperature.outdoorTemperature': 17,
      'measure_temperature.device': 30,
    });
    expect(planFeatures(device).map((feature) => feature.name)).toEqual(['thermostat', 'measure_temperature.device']);
  });

  test('should skip a thermostat without heating or cooling modes', () => {
    const device = createDevice('1', 'Thermostat', 'thermostat', { target_temperature: 21, thermostat_mode: { value: 'off', values: [{ id: 'off' }] } });
    expect(planFeatures(device)).toEqual([]);
  });

  test('should give conflicting sensors and sub-capabilities their own endpoint', () => {
    const device = createDevice('1', 'Multi', 'sensor', {
      'alarm_motion': false,
      'alarm_occupancy': false,
      'measure_temperature': 20,
      'measure_temperature.outside': 5,
    });
    const { main, children } = splitFeatures(planFeatures(device));
    expect(main.map((feature) => feature.name)).toEqual(['measure_temperature', 'alarm_motion']);
    expect(children.map((feature) => feature.name)).toEqual(['alarm_occupancy', 'measure_temperature.outside']);
  });

  test('should put the first sub-capability on the device endpoint when there is no main capability', () => {
    const device = createDevice('1', 'Double socket', 'socket', { 'onoff.output1': true, 'onoff.output2': false });
    const { main, children } = splitFeatures(planFeatures(device));
    expect(main.map((feature) => feature.name)).toEqual(['onoff.output1']);
    expect(children.map((feature) => feature.name)).toEqual(['onoff.output2']);
  });
});

describe('device names and zones', () => {
  test('should append the zone, then the ID, to duplicate names', () => {
    const devices = [
      createDevice('aaaa-1', 'Lamp', 'light', { onoff: true }, { zone: 'zone-living' }),
      createDevice('bbbb-2', 'Lamp', 'light', { onoff: true }, { zone: 'zone-kitchen' }),
      createDevice('cccc-3', 'Spot', 'light', { onoff: true }, { zone: 'zone-kitchen' }),
      createDevice('dddd-4', 'Spot', 'light', { onoff: true }, { zone: 'zone-kitchen' }),
      createDevice('eeee-5', 'Unique', 'light', { onoff: true }),
    ];
    const names = getUniqueDeviceNames(devices, zones);
    expect(names.get('aaaa-1')).toBe('Lamp Living room');
    expect(names.get('bbbb-2')).toBe('Lamp Kitchen');
    expect(names.get('cccc-3')).toBe('Spot Kitchen cccc');
    expect(names.get('dddd-4')).toBe('Spot Kitchen dddd');
    expect(names.get('eeee-5')).toBe('Unique');
  });

  test('should match devices in a zone or its sub-zones', () => {
    const pantryDevice = createDevice('1', 'Fridge light', 'light', { onoff: true }, { zone: 'zone-pantry' });
    expect(isInZones(pantryDevice, zones, [])).toBe(true);
    expect(isInZones(pantryDevice, zones, ['kitchen'])).toBe(true);
    expect(isInZones(pantryDevice, zones, ['Living room'])).toBe(false);
    expect(isInZones(createDevice('2', 'No zone', 'light', { onoff: true }, { zone: null }), zones, ['Home'])).toBe(false);
  });
});
