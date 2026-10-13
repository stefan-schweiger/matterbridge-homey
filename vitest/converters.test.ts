/**
 * @file vitest/converters.test.ts
 * @description Tests of the Homey <-> Matter value converters.
 * @author Stefan Schweiger
 */

import {
  batteryToMatter,
  clamp,
  dimToLevel,
  ellipsize,
  levelToDim,
  lightTemperatureToMireds,
  liftToWindowCoveringsSet,
  luxToMatter,
  matterColorToUnit,
  miredsToLightTemperature,
  scale,
  setpointToTargetTemperature,
  toHundredths,
  toThousandths,
  unitToMatterColor,
  windowCoveringsSetToLift,
} from '../src/converters.js';

describe('converters', () => {
  test('should clamp and scale numbers', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(scale(0.5, 0, 1, 0, 100)).toBe(50);
    expect(scale(2, 0, 1, 0, 100)).toBe(100);
    expect(scale(0.25, 0, 1, 100, 0)).toBe(75);
    expect(scale('x', 0, 1, 0, 100)).toBeNull();
    expect(scale(Number.NaN, 0, 1, 0, 100)).toBeNull();
  });

  test('should convert dim to level and back when the values are in range', () => {
    expect(dimToLevel(1)).toBe(254);
    expect(dimToLevel(0.5)).toBe(127);
    expect(dimToLevel(0)).toBe(1);
    expect(dimToLevel(null)).toBeNull();
    expect(levelToDim(254)).toBe(1);
    expect(levelToDim(127)).toBe(0.5);
    expect(levelToDim(1)).toBe(0.01);
  });

  test('should convert hue and saturation between 0..1 and 0..254', () => {
    expect(unitToMatterColor(0.5)).toBe(127);
    expect(unitToMatterColor('red')).toBeNull();
    expect(matterColorToUnit(254)).toBe(1);
    expect(matterColorToUnit(127)).toBe(0.5);
  });

  test('should map light_temperature 0 (cold) .. 1 (warm) onto 153..500 mireds', () => {
    expect(lightTemperatureToMireds(0)).toBe(153);
    expect(lightTemperatureToMireds(1)).toBe(500);
    expect(lightTemperatureToMireds(null)).toBe(250);
    expect(miredsToLightTemperature(153)).toBe(0);
    expect(miredsToLightTemperature(500)).toBe(1);
    expect(miredsToLightTemperature(1000)).toBe(1);
  });

  test('should invert window covering positions (Homey 1 = open, Matter 0 = open)', () => {
    expect(windowCoveringsSetToLift(1)).toBe(0);
    expect(windowCoveringsSetToLift(0)).toBe(10000);
    expect(windowCoveringsSetToLift(0.25)).toBe(7500);
    expect(windowCoveringsSetToLift(null)).toBeNull();
    expect(liftToWindowCoveringsSet(0)).toBe(1);
    expect(liftToWindowCoveringsSet(10000)).toBe(0);
    expect(liftToWindowCoveringsSet(7500)).toBe(0.25);
  });

  test('should convert setpoints to target temperatures within the capability range and step', () => {
    expect(setpointToTargetTemperature(2150)).toBe(21.5);
    expect(setpointToTargetTemperature(2130, { step: 0.5 })).toBe(21.5);
    expect(setpointToTargetTemperature(500, { min: 7, max: 30 })).toBe(7);
    expect(setpointToTargetTemperature(4000, { min: 7, max: 30 })).toBe(30);
  });

  test('should convert measurements', () => {
    expect(toHundredths(21.55)).toBe(2155);
    expect(toHundredths(null)).toBeNull();
    expect(toThousandths(12.5)).toBe(12500);
    expect(toThousandths('12')).toBeNull();
    expect(luxToMatter(1000)).toBe(30001);
    expect(luxToMatter(0.5)).toBe(0);
    expect(luxToMatter(1e9)).toBe(0xfffe);
    expect(luxToMatter(null)).toBeNull();
    expect(batteryToMatter(50)).toBe(100);
    expect(batteryToMatter(null)).toBeNull();
  });

  test('should shorten long names to 32 characters', () => {
    expect(ellipsize('short')).toBe('short');
    const long = ellipsize('A very long Homey device name that exceeds the limit');
    expect(long).toHaveLength(32);
    expect(long.endsWith('…')).toBe(true);
  });
});
