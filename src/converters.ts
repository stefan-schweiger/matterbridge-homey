/**
 * @file src/converters.ts
 * @description Value converters between Homey capability values and Matter attribute values.
 * @author Stefan Schweiger
 * @created 2026-10-11
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Copyright 2026 Stefan Schweiger.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Homey's light_temperature has no Kelvin values: it goes from 0 (coldest) to 1 (warmest) of the light's own range.
 * It is mapped onto a typical white range of 6500 K (153 mireds) to 2000 K (500 mireds), like the Homey Matter Bridge app does.
 */
export const colorTemperatureMinMireds = 153;
/** Warmest color temperature in mireds (2000 K). */
export const colorTemperatureMaxMireds = 500;
/** Default color temperature in mireds (4000 K), used when the light hasn't reported a temperature yet. */
export const colorTemperatureDefaultMireds = 250;

/**
 * Clamp a number into a range
 *
 * @param {number} value The value to clamp.
 * @param {number} min The lower bound.
 * @param {number} max The upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linearly scale a number from one range to another
 *
 * Edge cases:
 *  - Non-finite input -> null, so callers can fall back to a default
 *  - The result is clamped into the output range
 *
 * @param {unknown} value The value to scale.
 * @param {number} minInput Lower bound of the input range.
 * @param {number} maxInput Upper bound of the input range.
 * @param {number} minOutput Lower bound of the output range.
 * @param {number} maxOutput Upper bound of the output range.
 * @returns {number | null} The scaled value, or null when the value isn't a finite number.
 */
export function scale(value: unknown, minInput: number, maxInput: number, minOutput: number, maxOutput: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = ((value - minInput) / (maxInput - minInput)) * (maxOutput - minOutput) + minOutput;
  return clamp(scaled, Math.min(minOutput, maxOutput), Math.max(minOutput, maxOutput));
}

/**
 * Linearly scale and round a number from one range to another
 *
 * @param {unknown} value The value to scale.
 * @param {number} minInput Lower bound of the input range.
 * @param {number} maxInput Upper bound of the input range.
 * @param {number} minOutput Lower bound of the output range.
 * @param {number} maxOutput Upper bound of the output range.
 * @returns {number | null} The scaled and rounded value, or null when the value isn't a finite number.
 */
export function scaleRound(value: unknown, minInput: number, maxInput: number, minOutput: number, maxOutput: number): number | null {
  const scaled = scale(value, minInput, maxInput, minOutput, maxOutput);
  return scaled === null ? null : Math.round(scaled);
}

/**
 * Convert a Homey dim value to a Matter LevelControl currentLevel
 *
 * Edge cases:
 *  - dim 0 -> level 1 (the minimum level of a light)
 *
 * @param {unknown} dim Homey dim (0..1).
 * @returns {number | null} Matter level (1..254), or null when dim isn't a number.
 */
export function dimToLevel(dim: unknown): number | null {
  const level = scaleRound(dim, 0, 1, 0, 254);
  return level === null ? null : Math.max(level, 1);
}

/**
 * Convert a Matter LevelControl level to a Homey dim value
 *
 * Edge cases:
 *  - Never returns 0, which many Homey drivers treat as off: the minimum is 0.01
 *
 * @param {number} level Matter level (1..254).
 * @returns {number} Homey dim (0.01..1), rounded to 2 decimals.
 */
export function levelToDim(level: number): number {
  return Math.max(Math.round(clamp(level / 254, 0, 1) * 100) / 100, 0.01);
}

/**
 * Convert a Homey hue or saturation value to the Matter ColorControl range
 *
 * @param {unknown} value Homey light_hue or light_saturation (0..1).
 * @returns {number | null} Matter currentHue or currentSaturation (0..254), or null when the value isn't a number.
 */
export function unitToMatterColor(value: unknown): number | null {
  return scaleRound(value, 0, 1, 0, 254);
}

/**
 * Convert a Matter ColorControl hue or saturation to the Homey range
 *
 * @param {number} value Matter currentHue or currentSaturation (0..254).
 * @returns {number} Homey light_hue or light_saturation (0..1), rounded to 3 decimals.
 */
export function matterColorToUnit(value: number): number {
  return Math.round(clamp(value / 254, 0, 1) * 1000) / 1000;
}

/**
 * Convert a Homey light_temperature value to Matter mireds
 *
 * @param {unknown} value Homey light_temperature (0 = coldest .. 1 = warmest).
 * @returns {number} Color temperature in mireds (153..500). Defaults to 250 mireds when the value isn't a number.
 */
export function lightTemperatureToMireds(value: unknown): number {
  return scaleRound(value, 0, 1, colorTemperatureMinMireds, colorTemperatureMaxMireds) ?? colorTemperatureDefaultMireds;
}

/**
 * Convert Matter mireds to a Homey light_temperature value
 *
 * @param {number} mireds Color temperature in mireds.
 * @returns {number} Homey light_temperature (0..1), rounded to 3 decimals.
 */
export function miredsToLightTemperature(mireds: number): number {
  const value = scale(mireds, colorTemperatureMinMireds, colorTemperatureMaxMireds, 0, 1) ?? 0.5;
  return Math.round(value * 1000) / 1000;
}

/**
 * Convert a Homey windowcoverings_set value to a Matter lift position
 *
 * Homey uses 1 = fully open, Matter uses 0 = fully open and 10000 = fully closed.
 *
 * @param {unknown} value Homey windowcoverings_set (0..1).
 * @returns {number | null} Matter position in 100ths of a percent (0..10000), or null when the value isn't a number.
 */
export function windowCoveringsSetToLift(value: unknown): number | null {
  return scaleRound(value, 0, 1, 10000, 0);
}

/**
 * Convert a Matter lift position to a Homey windowcoverings_set value
 *
 * @param {number} percent100ths Matter position in 100ths of a percent (0 = open .. 10000 = closed).
 * @returns {number} Homey windowcoverings_set (0 = closed .. 1 = open), rounded to 2 decimals.
 */
export function liftToWindowCoveringsSet(percent100ths: number): number {
  return Math.round((1 - clamp(percent100ths / 10000, 0, 1)) * 100) / 100;
}

/**
 * Convert a Homey value to a Matter value in hundredths (temperature, humidity)
 *
 * @param {unknown} value Homey value (e.g. °C or %).
 * @returns {number | null} Value x 100, or null when the value isn't a number.
 */
export function toHundredths(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Convert a Matter temperature setpoint to a Homey target_temperature value
 *
 * Edge cases:
 *  - Rounds to the capability step (e.g. 0.5 °C) when the step is known
 *  - Clamps into the capability min/max when they are known
 *
 * @param {number} setpoint Matter setpoint in °C x 100.
 * @param {{ min?: number; max?: number; step?: number }} [capability] The Homey capability range.
 * @param {number} [capability.min] Minimum target temperature in °C.
 * @param {number} [capability.max] Maximum target temperature in °C.
 * @param {number} [capability.step] Step of the target temperature in °C.
 * @returns {number} The target temperature in °C.
 */
export function setpointToTargetTemperature(setpoint: number, capability?: { min?: number; max?: number; step?: number }): number {
  let value = setpoint / 100;
  const step = capability?.step;
  if (typeof step === 'number' && step > 0) value = Math.round(value / step) * step;
  if (typeof capability?.min === 'number') value = Math.max(value, capability.min);
  if (typeof capability?.max === 'number') value = Math.min(value, capability.max);
  return Math.round(value * 100) / 100;
}

/**
 * Convert lux to the Matter encoded illuminance value
 *
 * Matter spec: MeasuredValue = 10,000 x log10(illuminance) + 1, in the range 1 to 0xFFFE.
 *
 * Edge cases:
 *  - Not a number -> null (invalid measurement)
 *  - < 1 lux -> 0 (too low to be measured)
 *  - Caps at 0xFFFE
 *
 * @param {unknown} lux Illuminance in lux.
 * @returns {number | null} Encoded value (0, or 1..0xFFFE), or null when the value isn't a number.
 */
export function luxToMatter(lux: unknown): number | null {
  if (typeof lux !== 'number' || !Number.isFinite(lux)) return null;
  if (lux < 1) return 0;
  return Math.min(Math.round(10000 * Math.log10(lux) + 1), 0xfffe);
}

/**
 * Convert a Homey battery percentage to the Matter PowerSource batPercentRemaining
 *
 * @param {unknown} percent Homey measure_battery (0..100).
 * @returns {number | null} Matter batPercentRemaining (0..200, in half percent), or null when the value isn't a number.
 */
export function batteryToMatter(percent: unknown): number | null {
  return scaleRound(percent, 0, 100, 0, 200);
}

/**
 * Convert a Homey number to a Matter value in thousandths (e.g. W to mW, kWh to Wh)
 *
 * @param {unknown} value Homey value.
 * @returns {number | null} Value x 1000, or null when the value isn't a number.
 */
export function toThousandths(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 1000);
}

/**
 * Shorten a string to the Matter maximum length, ending it with an ellipsis when it is cut
 *
 * @param {string} value The string to shorten.
 * @param {number} [maxLength] The maximum length (default 32, the Matter limit for names and serial numbers).
 * @returns {string} The shortened string.
 */
export function ellipsize(value: string, maxLength: number = 32): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + '…' : value;
}
