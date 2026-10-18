/**
 * @file src/features.ts
 * @description Mapping of Homey device classes and capabilities to Matter device types, clusters and commands.
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

import {
  airQualitySensor,
  colorTemperatureLight,
  contactSensor,
  type DeviceTypeDefinition,
  dimmableLight,
  dimmablePlugInUnit,
  doorLock,
  electricalSensor,
  extendedColorLight,
  fan,
  humiditySensor,
  lightSensor,
  type MatterbridgeEndpoint,
  occupancySensor,
  onOffLight,
  onOffPlugInUnit,
  pressureSensor,
  rainSensor,
  roboticVacuumCleaner,
  smokeCoAlarm,
  temperatureSensor,
  thermostat,
  waterLeakDetector,
  windowCovering,
} from 'matterbridge';
import { MatterbridgeRvcCleanModeServer, MatterbridgeRvcOperationalStateServer, MatterbridgeRvcRunModeServer } from 'matterbridge/devices';
import type { ActionContext } from 'matterbridge/matter';
import {
  AirQuality,
  BooleanState,
  CarbonDioxideConcentrationMeasurement,
  CarbonMonoxideConcentrationMeasurement,
  ColorControl,
  DoorLock,
  ElectricalEnergyMeasurement,
  ElectricalPowerMeasurement,
  FanControl,
  IlluminanceMeasurement,
  LevelControl,
  OccupancySensing,
  OnOff,
  Pm10ConcentrationMeasurement,
  Pm25ConcentrationMeasurement,
  PressureMeasurement,
  RelativeHumidityMeasurement,
  RvcCleanMode,
  RvcOperationalState,
  RvcRunMode,
  SmokeCoAlarm,
  TemperatureMeasurement,
  Thermostat,
  TotalVolatileOrganicCompoundsConcentrationMeasurement,
  WindowCovering,
} from 'matterbridge/matter/clusters';
import { kelvinToRGB, miredToKelvin, rgbColorToHslColor, xyToHsl } from 'matterbridge/utils';

import {
  colorTemperatureMaxMireds,
  colorTemperatureMinMireds,
  dimToLevel,
  levelToDim,
  lightTemperatureToMireds,
  liftToWindowCoveringsSet,
  luxToMatter,
  matterColorToUnit,
  miredsToLightTemperature,
  setpointToTargetTemperature,
  toHundredths,
  toThousandths,
  unitToMatterColor,
  windowCoveringsSetToLift,
} from './converters.js';
import type { HomeyCapability, HomeyCapabilityValue, HomeyDevice } from './homey.js';

/** Updates the Matter state from a Homey capability value. */
export type CapabilityUpdate = (value: HomeyCapabilityValue) => Promise<void>;

/** Everything a feature needs to build its clusters on an endpoint and to connect them with Homey. */
export interface FeatureContext {
  /** The Homey device. */
  readonly device: HomeyDevice;
  /** The endpoint the feature is built on: the device endpoint or one of its child endpoints. */
  readonly endpoint: MatterbridgeEndpoint;
  /** Get the last known value of a capability. */
  value(capabilityId: string): HomeyCapabilityValue | undefined;
  /**
   * Send a value to Homey (Matter -> Homey). Errors are logged and the Matter state is restored from Homey.
   *
   * Homey doesn't echo the values it accepts. Set `reflect` to apply the accepted value to the Matter state like a value
   * reported by Homey, for attributes the Matter command doesn't update itself, e.g. the current position of a cover.
   */
  set(capabilityId: string, value: HomeyCapabilityValue, reflect?: boolean): void;
  /** Register an update of the Matter state from a Homey capability (Homey -> Matter). */
  bind(capabilityId: string, update: CapabilityUpdate): void;
}

/** A Matter function of a Homey device, e.g. a dimmable light or a temperature sensor. */
export interface Feature {
  /** Name of the feature, used as id of the child endpoint when the feature can't share the device endpoint. */
  readonly name: string;
  /** Matter device types of the feature. */
  readonly deviceTypes: DeviceTypeDefinition[];
  /** Matter clusters the feature uses: two features with a common cluster can't share an endpoint. */
  readonly clusters: string[];
  /** Homey capabilities the feature may use. Capabilities the device doesn't have are ignored. */
  readonly capabilities: string[];
  /** Whether the feature always needs its own child endpoint, e.g. for sub-capabilities like `onoff.output2`. */
  readonly ownEndpoint?: boolean;
  /** Create the cluster servers, command handlers and capability bindings. */
  build(context: FeatureContext): void;
}

/** Homey device classes exposed as Matter lights. */
const lightClasses = new Set(['light']);
/** Homey device classes exposed as Matter thermostats with heating. */
const heatingClasses = new Set(['thermostat', 'heater', 'heatpump', 'radiator', 'boiler']);
/** Homey device classes exposed as Matter thermostats with cooling. */
const coolingClasses = new Set(['airconditioning']);
/** Homey device classes exposed as Matter window coverings. */
const coveringClasses = new Set(['windowcoverings', 'blinds', 'curtain', 'sunshade', 'shutterblinds']);
/** Homey device classes exposed as Matter fans. */
const fanClasses = new Set(['fan', 'airpurifier']);
/** Homey device classes exposed as Matter door locks. */
const lockClasses = new Set(['lock']);
/** Homey device classes exposed as Matter robotic vacuum cleaners. */
const vacuumClasses = new Set(['vacuumcleaner']);
/** Homey device classes whose onoff sub-capabilities are outputs, e.g. onoff.output2 of a double socket. */
const outputClasses = new Set(['socket', 'other']);

/**
 * Check whether a Homey device has a capability
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {string} capabilityId The capability ID.
 * @returns {boolean} True when the device has the capability.
 */
export function hasCapability(device: HomeyDevice, capabilityId: string): boolean {
  return device.capabilities.includes(capabilityId);
}

/**
 * Get a capability definition of a Homey device
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {string} capabilityId The capability ID.
 * @returns {HomeyCapability | undefined} The capability, or undefined when the device doesn't have it.
 */
export function getCapability(device: HomeyDevice, capabilityId: string): HomeyCapability | undefined {
  return device.capabilitiesObj?.[capabilityId] ?? undefined;
}

/**
 * Get the effective Homey device class: the virtual class the user chose (e.g. a socket used as a light) or the driver class
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {string} The device class.
 */
export function getDeviceClass(device: HomeyDevice): string {
  return device.virtualClass ?? device.class;
}

/**
 * Check whether a Matter attribute change was made by a controller rather than by the plugin itself
 *
 * @param {ActionContext | undefined} context The Matter action context.
 * @returns {boolean} True when a controller made the change.
 */
function isFromController(context: ActionContext | undefined): boolean {
  return context?.fabric !== undefined;
}

/**
 * Get the last known value of a numeric capability
 *
 * @param {FeatureContext} context The feature context.
 * @param {string} capabilityId The capability ID.
 * @returns {number | undefined} The value, or undefined when it isn't a finite number.
 */
function numberValue(context: FeatureContext, capabilityId: string): number | undefined {
  const value = context.value(capabilityId);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Plan the Matter features of a Homey device
 *
 * The first feature is the main function of the device (from its class), followed by the sensors it also has.
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature[]} The features, empty when the device has nothing that can be exposed to Matter.
 */
export function planFeatures(device: HomeyDevice): Feature[] {
  const deviceClass = getDeviceClass(device);
  const features: Feature[] = [];
  const hasOnOff = hasCapability(device, 'onoff');
  let climate: Feature | undefined;

  if (lightClasses.has(deviceClass) && (hasOnOff || hasCapability(device, 'dim'))) features.push(lightFeature(device));
  else if ((heatingClasses.has(deviceClass) || coolingClasses.has(deviceClass)) && hasCapability(device, 'target_temperature')) {
    climate = climateFeature(device, coolingClasses.has(deviceClass));
    if (climate) features.push(climate);
  } else if (coveringClasses.has(deviceClass) && (hasCapability(device, 'windowcoverings_set') || hasCapability(device, 'windowcoverings_state'))) {
    features.push(windowCoveringFeature(device));
  } else if (lockClasses.has(deviceClass) && hasCapability(device, 'locked')) features.push(doorLockFeature());
  else if (fanClasses.has(deviceClass) && hasOnOff) features.push(fanFeature(device));
  // Only vacuums that can be started with a standard capability.
  else if (vacuumClasses.has(deviceClass) && (hasOnOff || hasCapability(device, 'vacuumcleaner_state'))) features.push(vacuumFeature(device));
  // Any other device that can be switched, e.g. a TV or a routine. The onoff of a sensor usually switches its display.
  else if (hasOnOff && deviceClass !== 'sensor') features.push(plugFeature(device, 'onoff'));

  // Sensors. A thermostat reports its temperature itself.
  if (!climate) addSensor(features, device, 'measure_temperature', temperatureFeature);
  addSensor(features, device, 'alarm_contact', contactFeature);
  addSensor(features, device, 'alarm_motion', occupancyFeature);
  addSensor(features, device, 'alarm_occupancy', occupancyFeature);
  addSensor(features, device, 'alarm_presence', occupancyFeature);
  addSensor(features, device, 'alarm_water', waterLeakFeature);
  addSensor(features, device, 'alarm_rain', rainFeature);
  if (hasCapability(device, 'alarm_smoke') || hasCapability(device, 'alarm_co')) features.push(smokeCoAlarmFeature(device));
  addSensor(features, device, 'measure_humidity', humidityFeature);
  addSensor(features, device, 'measure_pressure', pressureFeature);
  addSensor(features, device, 'measure_luminance', illuminanceFeature);
  if (['measure_co2', 'measure_co', 'measure_pm25', 'measure_pm10', 'measure_tvoc'].some((id) => hasCapability(device, id))) features.push(airQualityFeature(device));

  // Sub-capabilities, e.g. the second output of a double socket (onoff.output2) or an outside temperature (measure_temperature.outside).
  // Without a main function, the first output becomes the main function of the device.
  let hasMainFunction =
    features.length > 0 && features[0].clusters.some((cluster) => ['OnOff', 'Thermostat', 'WindowCovering', 'DoorLock', 'FanControl', 'RvcRunMode'].includes(cluster));
  for (const capabilityId of device.capabilities) {
    const [base, sub] = capabilityId.split('.');
    if (sub === undefined) continue;
    if (base === 'onoff' && outputClasses.has(deviceClass)) {
      features.push({ ...plugFeature(device, capabilityId), name: capabilityId, ownEndpoint: hasMainFunction });
      hasMainFunction = true;
    }
    // A thermostat reports the outdoor temperature itself, so it isn't a separate (unnamed) sensor.
    if (base === 'measure_temperature' && !(climate && capabilityId === getOutdoorTemperatureCapability(device))) {
      features.push({ ...temperatureFeature(capabilityId), ownEndpoint: true });
    }
    if (base === 'measure_humidity') features.push({ ...humidityFeature(capabilityId), ownEndpoint: true });
    if (base === 'alarm_contact') features.push({ ...contactFeature(capabilityId), ownEndpoint: true });
    if (base === 'alarm_motion' || base === 'alarm_presence') features.push({ ...occupancyFeature(capabilityId), ownEndpoint: true });
    if (base === 'alarm_water') features.push({ ...waterLeakFeature(capabilityId), ownEndpoint: true });
  }
  // Power and energy only accompany another function, e.g. a socket.
  if (features.length > 0 && (hasCapability(device, 'measure_power') || hasCapability(device, 'meter_power'))) features.push(electricalFeature(device));
  return features;
}

/**
 * Get the Homey capabilities a device exposes to Matter
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {string[]} The capability IDs, empty when the device has nothing that can be exposed to Matter.
 */
export function getExposedCapabilities(device: HomeyDevice): string[] {
  const features = planFeatures(device);
  if (features.length === 0) return [];
  const capabilities = new Set([...features.flatMap((feature) => feature.capabilities), 'measure_battery', 'alarm_battery']);
  return device.capabilities.filter((capabilityId) => capabilities.has(capabilityId));
}

/**
 * Add a sensor feature when the device has the capability
 *
 * @param {Feature[]} features The features to add to.
 * @param {HomeyDevice} device The Homey device.
 * @param {string} capabilityId The sensor capability.
 * @param {(capabilityId: string) => Feature} factory Creates the feature.
 */
function addSensor(features: Feature[], device: HomeyDevice, capabilityId: string, factory: (capabilityId: string) => Feature): void {
  if (hasCapability(device, capabilityId)) features.push(factory(capabilityId));
}

// ********************************************* Lights and plugs ***************************************************

/**
 * Create the light feature: on/off, dimmable, color temperature or extended color light, depending on the capabilities
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function lightFeature(device: HomeyDevice): Feature {
  const hasDim = hasCapability(device, 'dim');
  const hasHueSaturation = hasCapability(device, 'light_hue') && hasCapability(device, 'light_saturation');
  const hasTemperature = hasCapability(device, 'light_temperature');
  let deviceType = onOffLight;
  if (hasDim) deviceType = dimmableLight;
  if (hasTemperature) deviceType = colorTemperatureLight;
  if (hasHueSaturation) deviceType = extendedColorLight;
  const clusters = ['OnOff', ...(hasDim || hasTemperature || hasHueSaturation ? ['LevelControl'] : []), ...(hasTemperature || hasHueSaturation ? ['ColorControl'] : [])];

  return {
    name: 'light',
    capabilities: ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature', 'light_mode'],
    deviceTypes: [deviceType],
    clusters,
    build: (context) => {
      buildOnOff(context, 'onoff', true);
      if (clusters.includes('LevelControl')) buildLevelControl(context);
      if (hasHueSaturation) buildColorControl(context, hasTemperature);
      else if (hasTemperature) buildColorTemperature(context);
    },
  };
}

/**
 * Create the plug feature: a (dimmable) plug-in unit
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {string} capabilityId The on/off capability, e.g. onoff or onoff.output2.
 * @returns {Feature} The feature.
 */
function plugFeature(device: HomeyDevice, capabilityId: string): Feature {
  const isDimmable = capabilityId === 'onoff' && hasCapability(device, 'dim');
  return {
    name: 'plug',
    capabilities: [capabilityId, ...(isDimmable ? ['dim'] : [])],
    deviceTypes: [isDimmable ? dimmablePlugInUnit : onOffPlugInUnit],
    clusters: isDimmable ? ['OnOff', 'LevelControl'] : ['OnOff'],
    build: (context) => {
      buildOnOff(context, capabilityId, isDimmable);
      if (isDimmable) buildLevelControl(context);
    },
  };
}

/**
 * Build the OnOff cluster connected to a Homey on/off capability
 *
 * @param {FeatureContext} context The feature context.
 * @param {string} capabilityId The on/off capability, e.g. onoff or onoff.output2.
 * @param {boolean} isLighting Whether to create the OnOff cluster with the Lighting feature.
 */
function buildOnOff(context: FeatureContext, capabilityId: string, isLighting: boolean): void {
  const { device, endpoint } = context;
  const isOn = context.value(capabilityId) === true;
  if (isLighting) endpoint.createDefaultOnOffClusterServer(isOn);
  else endpoint.createOnOffClusterServer(isOn);

  if (hasCapability(device, capabilityId)) {
    endpoint.addCommandHandler('on', () => context.set(capabilityId, true));
    endpoint.addCommandHandler('off', () => context.set(capabilityId, false));
    endpoint.addCommandHandler('toggle', ({ attributes }) => context.set(capabilityId, !attributes.onOff));
    context.bind(capabilityId, async (value) => {
      await endpoint.updateAttribute(OnOff, 'onOff', value === true, endpoint.log);
    });
  } else {
    // A light with dim only: on and off are sent as dim values.
    endpoint.addCommandHandler('on', () => context.set('dim', levelToDim(endpoint.getAttribute(LevelControl, 'currentLevel') ?? 254)));
    endpoint.addCommandHandler('off', () => context.set('dim', 0));
    context.bind('dim', async (value) => {
      await endpoint.updateAttribute(OnOff, 'onOff', typeof value === 'number' && value > 0, endpoint.log);
    });
  }
}

/**
 * Build the LevelControl cluster connected to the Homey dim capability
 *
 * @param {FeatureContext} context The feature context.
 */
function buildLevelControl(context: FeatureContext): void {
  const { device, endpoint } = context;
  const hasOnOff = hasCapability(device, 'onoff');
  endpoint.createDefaultLevelControlClusterServer(dimToLevel(context.value('dim')) ?? 254);
  if (!hasCapability(device, 'dim')) return;

  const setLevel = (level: number, withOnOff: boolean): void => {
    if (withOnOff && hasOnOff && level <= 1) {
      context.set('onoff', false);
      return;
    }
    context.set('dim', levelToDim(level));
    if (withOnOff && hasOnOff && context.value('onoff') !== true) context.set('onoff', true);
  };
  const stepLevel = (stepMode: LevelControl.StepMode, stepSize: number, withOnOff: boolean): void => {
    const current = endpoint.getAttribute(LevelControl, 'currentLevel') ?? 254;
    setLevel(Math.min(Math.max(current + (stepMode === LevelControl.StepMode.Up ? stepSize : -stepSize), 1), 254), withOnOff);
  };
  endpoint.addCommandHandler('moveToLevel', ({ request }) => setLevel(request.level, false));
  endpoint.addCommandHandler('moveToLevelWithOnOff', ({ request }) => setLevel(request.level, true));
  endpoint.addCommandHandler('LevelControl.step', ({ request }) => stepLevel(request.stepMode, request.stepSize, false));
  endpoint.addCommandHandler('LevelControl.stepWithOnOff', ({ request }) => stepLevel(request.stepMode, request.stepSize, true));
  context.bind('dim', async (value) => {
    const level = dimToLevel(value);
    if (level !== null) await endpoint.updateAttribute(LevelControl, 'currentLevel', level, endpoint.log);
  });
}

/**
 * Build the ColorControl cluster (xy, hue/saturation and color temperature) for a Homey color light
 *
 * @param {FeatureContext} context The feature context.
 * @param {boolean} hasTemperature Whether the light also has the light_temperature capability.
 */
function buildColorControl(context: FeatureContext, hasTemperature: boolean): void {
  const { device, endpoint } = context;
  const hasMode = hasCapability(device, 'light_mode');
  endpoint.createDefaultColorControlClusterServer(
    0,
    0,
    unitToMatterColor(context.value('light_hue')) ?? 0,
    unitToMatterColor(context.value('light_saturation')) ?? 0,
    lightTemperatureToMireds(context.value('light_temperature')),
    colorTemperatureMinMireds,
    colorTemperatureMaxMireds,
  );

  const setHueSaturation = (hue: number | undefined, saturation: number | undefined): void => {
    if (hue !== undefined) context.set('light_hue', hue);
    if (saturation !== undefined) context.set('light_saturation', saturation);
    if (hasMode) context.set('light_mode', 'color');
  };
  endpoint.addCommandHandler('moveToHue', ({ request }) => setHueSaturation(matterColorToUnit(request.hue), undefined));
  endpoint.addCommandHandler('moveToSaturation', ({ request }) => setHueSaturation(undefined, matterColorToUnit(request.saturation)));
  endpoint.addCommandHandler('moveToHueAndSaturation', ({ request }) => setHueSaturation(matterColorToUnit(request.hue), matterColorToUnit(request.saturation)));
  endpoint.addCommandHandler('moveToColor', ({ request }) => {
    const hsl = xyToHsl(request.colorX / 65536, request.colorY / 65536);
    setHueSaturation(Math.round((hsl.h / 360) * 1000) / 1000, Math.round(hsl.s) / 100);
  });
  endpoint.addCommandHandler('moveToColorTemperature', ({ request }) => {
    if (hasTemperature) {
      context.set('light_temperature', miredsToLightTemperature(request.colorTemperatureMireds));
      if (hasMode) context.set('light_mode', 'temperature');
    } else {
      // A light without white temperature: show the color of that temperature instead.
      const hsl = rgbColorToHslColor(kelvinToRGB(miredToKelvin(request.colorTemperatureMireds)));
      setHueSaturation(Math.round((hsl.h / 360) * 1000) / 1000, Math.round(hsl.s) / 100);
    }
  });

  const isColorMode = (): boolean => !hasTemperature || !hasMode || context.value('light_mode') !== 'temperature';
  context.bind('light_hue', async (value) => {
    const hue = unitToMatterColor(value);
    if (hue !== null) await endpoint.updateAttribute(ColorControl, 'currentHue', hue, endpoint.log);
    if (hue !== null && isColorMode()) await endpoint.configureColorControlMode(ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
  });
  context.bind('light_saturation', async (value) => {
    const saturation = unitToMatterColor(value);
    if (saturation !== null) await endpoint.updateAttribute(ColorControl, 'currentSaturation', saturation, endpoint.log);
    if (saturation !== null && isColorMode()) await endpoint.configureColorControlMode(ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
  });
  if (!hasTemperature) return;
  context.bind('light_temperature', async (value) => {
    if (typeof value !== 'number') return;
    await endpoint.updateAttribute(ColorControl, 'colorTemperatureMireds', lightTemperatureToMireds(value), endpoint.log);
    if (!isColorMode()) await endpoint.configureColorControlMode(ColorControl.ColorMode.ColorTemperatureMireds);
  });
  context.bind('light_mode', async (value) => {
    if (value === 'color') await endpoint.configureColorControlMode(ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
    if (value === 'temperature') await endpoint.configureColorControlMode(ColorControl.ColorMode.ColorTemperatureMireds);
  });
}

/**
 * Build the ColorControl cluster with color temperature only, for a Homey white light
 *
 * @param {FeatureContext} context The feature context.
 */
function buildColorTemperature(context: FeatureContext): void {
  const { endpoint } = context;
  endpoint.createCtColorControlClusterServer(lightTemperatureToMireds(context.value('light_temperature')), colorTemperatureMinMireds, colorTemperatureMaxMireds);
  endpoint.addCommandHandler('moveToColorTemperature', ({ request }) => context.set('light_temperature', miredsToLightTemperature(request.colorTemperatureMireds)));
  context.bind('light_temperature', async (value) => {
    if (typeof value === 'number') await endpoint.updateAttribute(ColorControl, 'colorTemperatureMireds', lightTemperatureToMireds(value), endpoint.log);
  });
}

// ************************************************* Climate ********************************************************

/** Matter system modes for the Homey thermostat_mode values. */
const systemModes: Readonly<Record<string, Thermostat.SystemMode>> = {
  off: Thermostat.SystemMode.Off,
  heat: Thermostat.SystemMode.Heat,
  cool: Thermostat.SystemMode.Cool,
  auto: Thermostat.SystemMode.Auto,
  fanonly: Thermostat.SystemMode.FanOnly,
  dry: Thermostat.SystemMode.Dry,
};

/**
 * Get the outdoor temperature sub-capability of a device, e.g. measure_temperature.outdoorTemperature of an air conditioner
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {string | undefined} The capability ID, or undefined when the device has none.
 */
export function getOutdoorTemperatureCapability(device: HomeyDevice): string | undefined {
  return device.capabilities.find((capabilityId) => /^measure_temperature\..*out(door|side)/i.test(capabilityId));
}

/**
 * Create the thermostat feature
 *
 * Homey has one target temperature, so the heating and cooling setpoints are the same value. An outdoor temperature
 * sub-capability becomes the outdoorTemperature attribute of the thermostat.
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {boolean} isCooling Whether the device cools by default (air conditioning) instead of heating.
 * @returns {Feature | undefined} The feature, or undefined when the thermostat has no mode Matter supports.
 */
function climateFeature(device: HomeyDevice, isCooling: boolean): Feature | undefined {
  const modeIds = new Set((getCapability(device, 'thermostat_mode')?.values ?? []).map((mode) => mode.id));
  const hasModes = modeIds.size > 0;
  const canHeat = hasModes ? modeIds.has('heat') || modeIds.has('auto') : !isCooling;
  const canCool = hasModes ? modeIds.has('cool') || modeIds.has('auto') : isCooling;
  if (!canHeat && !canCool) return undefined;
  const hasOnOff = hasCapability(device, 'onoff');
  const defaultMode = canHeat && canCool ? Thermostat.SystemMode.Auto : canHeat ? Thermostat.SystemMode.Heat : Thermostat.SystemMode.Cool;
  const outdoorId = getOutdoorTemperatureCapability(device);

  return {
    name: 'thermostat',
    capabilities: ['target_temperature', 'measure_temperature', 'thermostat_mode', 'onoff', ...(outdoorId ? [outdoorId] : [])],
    deviceTypes: [thermostat],
    clusters: ['Thermostat'],
    build: (context) => {
      const { endpoint } = context;
      const target = getCapability(device, 'target_temperature');
      const min = target?.min ?? 4;
      const max = target?.max ?? 35;
      const setpoint = Math.min(Math.max(numberValue(context, 'target_temperature') ?? 21, min), max);
      const local = numberValue(context, 'measure_temperature') ?? setpoint;
      // Undefined leaves out the outdoorTemperature attribute, null is an unknown outdoor temperature.
      const outdoor = outdoorId ? (numberValue(context, outdoorId) ?? null) : undefined;
      if (canHeat && canCool) endpoint.createDefaultThermostatClusterServer(local, setpoint, setpoint, 0, min, max, min, max, undefined, undefined, undefined, outdoor);
      else if (canHeat) endpoint.createDefaultHeatingThermostatClusterServer(local, setpoint, min, max, undefined, undefined, outdoor);
      else endpoint.createDefaultCoolingThermostatClusterServer(local, setpoint, min, max, undefined, undefined, outdoor);

      const currentSystemMode = (): Thermostat.SystemMode => {
        if (hasOnOff && context.value('onoff') === false) return Thermostat.SystemMode.Off;
        const mode = context.value('thermostat_mode');
        return (typeof mode === 'string' ? systemModes[mode] : undefined) ?? defaultMode;
      };
      const onSetpoint = (value: number, _oldValue: number, actionContext: ActionContext): void => {
        if (isFromController(actionContext)) context.set('target_temperature', setpointToTargetTemperature(value, target));
      };
      if (canHeat) endpoint.subscribeAttribute(Thermostat, 'occupiedHeatingSetpoint', onSetpoint, endpoint.log);
      if (canCool) endpoint.subscribeAttribute(Thermostat, 'occupiedCoolingSetpoint', onSetpoint, endpoint.log);
      endpoint.subscribeAttribute(
        Thermostat,
        'systemMode',
        (value: Thermostat.SystemMode, _oldValue: Thermostat.SystemMode, actionContext: ActionContext) => {
          if (!isFromController(actionContext)) return;
          const modeId = Object.keys(systemModes).find((id) => systemModes[id] === value);
          // onoff is the power switch: drivers don't always switch the device off with the off mode.
          if (value === Thermostat.SystemMode.Off && hasOnOff) context.set('onoff', false);
          else if (modeId !== undefined && modeIds.has(modeId)) context.set('thermostat_mode', modeId);
          if (value !== Thermostat.SystemMode.Off && hasOnOff && context.value('onoff') === false) context.set('onoff', true);
        },
        endpoint.log,
      );

      context.bind('target_temperature', async (value) => {
        const hundredths = toHundredths(value);
        if (hundredths === null) return;
        if (canHeat) await endpoint.updateAttribute(Thermostat, 'occupiedHeatingSetpoint', hundredths, endpoint.log);
        if (canCool) await endpoint.updateAttribute(Thermostat, 'occupiedCoolingSetpoint', hundredths, endpoint.log);
      });
      context.bind('measure_temperature', async (value) => {
        await endpoint.updateAttribute(Thermostat, 'localTemperature', toHundredths(value), endpoint.log);
      });
      if (outdoorId) {
        context.bind(outdoorId, async (value) => {
          await endpoint.updateAttribute(Thermostat, 'outdoorTemperature', toHundredths(value), endpoint.log);
        });
      }
      const updateSystemMode = async (): Promise<void> => {
        await endpoint.updateAttribute(Thermostat, 'systemMode', currentSystemMode(), endpoint.log);
      };
      if (hasModes) context.bind('thermostat_mode', updateSystemMode);
      if (hasOnOff) context.bind('onoff', updateSystemMode);
    },
  };
}

/**
 * Create the fan feature
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function fanFeature(device: HomeyDevice): Feature {
  const hasSpeed = hasCapability(device, 'fan_speed');
  return {
    name: 'fan',
    capabilities: ['onoff', 'fan_speed'],
    deviceTypes: [fan],
    clusters: ['FanControl'],
    build: (context) => {
      const { endpoint } = context;
      const percent = (): number => {
        if (context.value('onoff') !== true) return 0;
        const speed = context.value('fan_speed');
        return hasSpeed && typeof speed === 'number' ? Math.round(speed * 100) : 100;
      };
      if (hasSpeed)
        endpoint.createBaseFanControlClusterServer(
          percent() > 0 ? FanControl.FanMode.High : FanControl.FanMode.Off,
          FanControl.FanModeSequence.OffLowMedHigh,
          percent(),
          percent(),
        );
      else endpoint.createOnOffFanControlClusterServer(percent() > 0 ? FanControl.FanMode.High : FanControl.FanMode.Off);

      // The fan control server keeps fanMode and percentSetting in sync, so listening to percentSetting is enough.
      endpoint.subscribeAttribute(
        FanControl,
        'percentSetting',
        (value: number | null, _oldValue: number | null, actionContext: ActionContext) => {
          if (!isFromController(actionContext) || value === null) return;
          if (value === 0) {
            context.set('onoff', false, true);
            return;
          }
          if (hasSpeed) context.set('fan_speed', Math.round(value) / 100, true);
          if (context.value('onoff') !== true) context.set('onoff', true, true);
        },
        endpoint.log,
      );
      const update = async (): Promise<void> => {
        await endpoint.updateAttribute(FanControl, 'percentSetting', percent(), endpoint.log);
        await endpoint.updateAttribute(FanControl, 'percentCurrent', percent(), endpoint.log);
      };
      context.bind('onoff', update);
      if (hasSpeed) context.bind('fan_speed', update);
    },
  };
}

// ********************************************* Covers and locks ***************************************************

/**
 * Create the window covering feature (lift only)
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function windowCoveringFeature(device: HomeyDevice): Feature {
  const hasPosition = hasCapability(device, 'windowcoverings_set');
  const hasState = hasCapability(device, 'windowcoverings_state');
  return {
    name: 'windowcovering',
    capabilities: ['windowcoverings_set', 'windowcoverings_state'],
    deviceTypes: [windowCovering],
    clusters: ['WindowCovering'],
    build: (context) => {
      const { endpoint } = context;
      const position = hasPosition ? windowCoveringsSetToLift(context.value('windowcoverings_set')) : null;
      endpoint.createDefaultWindowCoveringClusterServer(position);

      endpoint.addCommandHandler('upOrOpen', () => {
        if (hasState) context.set('windowcoverings_state', 'up', true);
        else context.set('windowcoverings_set', 1, true);
      });
      endpoint.addCommandHandler('downOrClose', () => {
        if (hasState) context.set('windowcoverings_state', 'down', true);
        else context.set('windowcoverings_set', 0, true);
      });
      endpoint.addCommandHandler('stopMotion', () => {
        if (hasState) context.set('windowcoverings_state', 'idle', true);
      });
      endpoint.addCommandHandler('goToLiftPercentage', ({ request }) => {
        if (hasPosition) context.set('windowcoverings_set', liftToWindowCoveringsSet(request.liftPercent100thsValue), true);
        else context.set('windowcoverings_state', request.liftPercent100thsValue >= 5000 ? 'down' : 'up', true);
      });

      if (hasPosition) {
        context.bind('windowcoverings_set', async (value) => {
          const lift = windowCoveringsSetToLift(value);
          if (lift === null) return;
          await endpoint.setWindowCoveringTargetAndCurrentPosition(lift);
        });
      }
      if (hasState) {
        context.bind('windowcoverings_state', async (value) => {
          if (value === 'up') await endpoint.setWindowCoveringStatus(WindowCovering.MovementStatus.Opening);
          else if (value === 'down') await endpoint.setWindowCoveringStatus(WindowCovering.MovementStatus.Closing);
          else if (hasPosition) await endpoint.setWindowCoveringStatus(WindowCovering.MovementStatus.Stopped);
          // Without a position, assume a stopped cover reached the position it was sent to.
          else await endpoint.setWindowCoveringTargetAsCurrentAndStopped();
        });
      }
    },
  };
}

/**
 * Create the door lock feature
 *
 * @returns {Feature} The feature.
 */
function doorLockFeature(): Feature {
  return {
    name: 'lock',
    capabilities: ['locked'],
    deviceTypes: [doorLock],
    clusters: ['DoorLock'],
    build: (context) => {
      const { endpoint } = context;
      const lockState = (value: HomeyCapabilityValue | undefined): DoorLock.LockState => (value === false ? DoorLock.LockState.Unlocked : DoorLock.LockState.Locked);
      endpoint.createDefaultDoorLockClusterServer(lockState(context.value('locked')));
      endpoint.addCommandHandler('lockDoor', () => context.set('locked', true));
      endpoint.addCommandHandler('unlockDoor', () => context.set('locked', false));
      context.bind('locked', async (value) => {
        await endpoint.updateAttribute(DoorLock, 'lockState', lockState(value), endpoint.log);
      });
    },
  };
}

// ************************************************* Vacuums ********************************************************

/** Matter run mode of an idle vacuum. */
const vacuumIdleMode = 1;
/** Matter run mode of a cleaning vacuum. */
const vacuumCleaningMode = 2;

/**
 * Matter clean modes of the standard values of vacuumcleaner_job_mode
 *
 * The mode numbers are fixed per value, so they don't depend on the values a device offers. `off` isn't a clean mode.
 */
const vacuumCleanModes: Readonly<Record<string, RvcCleanMode.ModeOption>> = {
  normal: { label: 'Normal', mode: 1, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }] },
  high: { label: 'High', mode: 2, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.DeepClean }] },
  turbo: { label: 'Turbo', mode: 3, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Max }] },
  mop: { label: 'Mop', mode: 4, modeTags: [{ value: RvcCleanMode.ModeTag.Mop }] },
  auto: { label: 'Auto', mode: 5, modeTags: [{ value: RvcCleanMode.ModeTag.Auto }, { value: RvcCleanMode.ModeTag.Vacuum }] },
};

/** Matter operational states of the standard values of vacuumcleaner_state. */
const vacuumStates: Readonly<Record<string, RvcOperationalState.OperationalState>> = {
  cleaning: RvcOperationalState.OperationalState.Running,
  spot_cleaning: RvcOperationalState.OperationalState.Running,
  docked: RvcOperationalState.OperationalState.Docked,
  charging: RvcOperationalState.OperationalState.Charging,
  stopped: RvcOperationalState.OperationalState.Stopped,
};

/** Matter operational states of the standard values of operational_state. */
const vacuumOperationalStates: Readonly<Record<string, RvcOperationalState.OperationalState>> = {
  stopped: RvcOperationalState.OperationalState.Stopped,
  running: RvcOperationalState.OperationalState.Running,
  paused: RvcOperationalState.OperationalState.Paused,
  error: RvcOperationalState.OperationalState.Error,
};

/**
 * Get the standard vacuumcleaner_job_mode values of a vacuum that are Matter clean modes
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {string[]} The values, empty when the device has no standard clean modes.
 */
export function getVacuumCleanModes(device: HomeyDevice): string[] {
  if (!hasCapability(device, 'vacuumcleaner_job_mode')) return [];
  const values = getCapability(device, 'vacuumcleaner_job_mode')?.values?.map((value) => value.id) ?? Object.keys(vacuumCleanModes);
  return values.filter((value) => Object.hasOwn(vacuumCleanModes, value));
}

/**
 * Look up a standard Homey enum value in a mapping
 *
 * @template T The mapped type.
 * @param {Readonly<Record<string, T>>} mapping The mapping of the standard values.
 * @param {HomeyCapabilityValue | undefined} value The Homey value.
 * @returns {T | undefined} The mapped value, or undefined when the value isn't a standard value.
 */
function mapStandardValue<T>(mapping: Readonly<Record<string, T>>, value: HomeyCapabilityValue | undefined): T | undefined {
  return typeof value === 'string' && Object.hasOwn(mapping, value) ? mapping[value] : undefined;
}

/**
 * Create the robotic vacuum cleaner feature
 *
 * Only the standard capabilities and values of Homey are used: vacuumcleaner_state or onoff to start and stop the
 * vacuum, the standard values of operational_state and vacuumcleaner_job_mode. Homey has no standard pause, so a paused
 * vacuum is stopped in Homey.
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function vacuumFeature(device: HomeyDevice): Feature {
  const hasState = hasCapability(device, 'vacuumcleaner_state');
  const cleanModeIds = getVacuumCleanModes(device);
  const { OperationalState } = RvcOperationalState;
  return {
    name: 'vacuum',
    capabilities: ['vacuumcleaner_state', 'onoff', 'operational_state', 'vacuumcleaner_job_mode'],
    deviceTypes: [roboticVacuumCleaner],
    clusters: ['RvcRunMode', 'RvcCleanMode', 'RvcOperationalState'],
    build: (context) => {
      const { endpoint } = context;
      const operationalState = (): RvcOperationalState.OperationalState => {
        const operational = mapStandardValue(vacuumOperationalStates, context.value('operational_state'));
        if (operational === OperationalState.Paused || operational === OperationalState.Error) return operational;
        return (
          mapStandardValue(vacuumStates, context.value('vacuumcleaner_state')) ??
          operational ??
          (context.value('onoff') === true ? OperationalState.Running : OperationalState.Stopped)
        );
      };
      const operationalError = (state: RvcOperationalState.OperationalState): RvcOperationalState.ErrorStateStruct =>
        state === OperationalState.Error
          ? { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation }
          : { errorStateId: RvcOperationalState.ErrorState.NoError, errorStateDetails: 'Fully operational' };
      // A paused vacuum is still in its cleaning run.
      const runMode = (state: RvcOperationalState.OperationalState): number =>
        state === OperationalState.Running || state === OperationalState.Paused ? vacuumCleaningMode : vacuumIdleMode;
      // A job mode that isn't a clean mode, e.g. off, shows the first clean mode.
      const cleanMode = (): number => {
        const jobMode = context.value('vacuumcleaner_job_mode');
        return vacuumCleanModes[typeof jobMode === 'string' && cleanModeIds.includes(jobMode) ? jobMode : cleanModeIds[0]].mode;
      };

      const state = operationalState();
      endpoint.behaviors.require(MatterbridgeRvcRunModeServer, {
        supportedModes: [
          { label: 'Idle', mode: vacuumIdleMode, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
          { label: 'Cleaning', mode: vacuumCleaningMode, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
        ],
        currentMode: runMode(state),
      });
      if (cleanModeIds.length > 0) {
        endpoint.behaviors.require(MatterbridgeRvcCleanModeServer, { supportedModes: cleanModeIds.map((id) => vacuumCleanModes[id]), currentMode: cleanMode() });
      }
      endpoint.behaviors.require(MatterbridgeRvcOperationalStateServer, {
        phaseList: null,
        currentPhase: null,
        countdownTime: null,
        operationalStateList: [
          OperationalState.Stopped,
          OperationalState.Running,
          OperationalState.Paused,
          OperationalState.Error,
          OperationalState.SeekingCharger,
          OperationalState.Charging,
          OperationalState.Docked,
        ].map((operationalStateId) => ({ operationalStateId })),
        operationalState: state,
        operationalError: operationalError(state),
      });

      // The Matter servers call the handlers before they check the command, so the handlers only act where the servers accept it.
      const start = (): void => {
        if (hasState) context.set('vacuumcleaner_state', 'cleaning', true);
        else context.set('onoff', true, true);
      };
      const stop = (vacuumState: 'stopped' | 'docked', reflect: boolean): void => {
        if (hasState) context.set('vacuumcleaner_state', vacuumState, reflect);
        else context.set('onoff', false, reflect);
      };
      endpoint.addCommandHandler('RvcRunMode.changeToMode', ({ request, attributes }) => {
        if (request.newMode === attributes.currentMode) return;
        if (request.newMode === vacuumCleaningMode) start();
        else if (request.newMode === vacuumIdleMode) stop('stopped', true);
      });
      // Not reflected: the vacuum stays paused in Matter, so it can be resumed.
      endpoint.addCommandHandler('RvcOperationalState.pause', ({ attributes }) => {
        if (attributes.operationalState === OperationalState.Running || attributes.operationalState === OperationalState.SeekingCharger) stop('stopped', false);
      });
      endpoint.addCommandHandler('RvcOperationalState.resume', ({ attributes }) => {
        if (attributes.operationalState === OperationalState.Paused) start();
      });
      endpoint.addCommandHandler('RvcOperationalState.goHome', ({ attributes }) => {
        if (
          attributes.operationalState === OperationalState.Stopped ||
          attributes.operationalState === OperationalState.Running ||
          attributes.operationalState === OperationalState.Paused
        )
          stop('docked', true);
      });
      if (cleanModeIds.length > 0) {
        endpoint.addCommandHandler('RvcCleanMode.changeToMode', ({ request, attributes }) => {
          const modeId = cleanModeIds.find((id) => vacuumCleanModes[id].mode === request.newMode);
          // Matter only changes the clean mode of an idle vacuum.
          if (modeId === undefined || request.newMode === attributes.currentMode || endpoint.getAttribute(RvcRunMode, 'currentMode') !== vacuumIdleMode) return;
          context.set('vacuumcleaner_job_mode', modeId, true);
        });
      }

      const update = async (): Promise<void> => {
        const newState = operationalState();
        await endpoint.updateAttribute(RvcOperationalState, 'operationalState', newState, endpoint.log);
        await endpoint.updateAttribute(RvcOperationalState, 'operationalError', operationalError(newState), endpoint.log);
        await endpoint.updateAttribute(RvcRunMode, 'currentMode', runMode(newState), endpoint.log);
      };
      for (const capabilityId of ['vacuumcleaner_state', 'operational_state', 'onoff']) context.bind(capabilityId, update);
      if (cleanModeIds.length > 0) {
        context.bind('vacuumcleaner_job_mode', async () => {
          await endpoint.updateAttribute(RvcCleanMode, 'currentMode', cleanMode(), endpoint.log);
        });
      }
    },
  };
}

// ************************************************* Sensors ********************************************************

/**
 * Create a temperature sensor feature
 *
 * @param {string} capabilityId The capability, e.g. measure_temperature or measure_temperature.outside.
 * @returns {Feature} The feature.
 */
function temperatureFeature(capabilityId: string): Feature {
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [temperatureSensor],
    clusters: ['TemperatureMeasurement'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultTemperatureMeasurementClusterServer(toHundredths(context.value(capabilityId)));
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(TemperatureMeasurement, 'measuredValue', toHundredths(value), endpoint.log);
      });
    },
  };
}

/**
 * Create a humidity sensor feature
 *
 * @param {string} capabilityId The capability, e.g. measure_humidity (0..100 %).
 * @returns {Feature} The feature.
 */
function humidityFeature(capabilityId: string): Feature {
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [humiditySensor],
    clusters: ['RelativeHumidityMeasurement'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultRelativeHumidityMeasurementClusterServer(toHundredths(context.value(capabilityId)));
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(RelativeHumidityMeasurement, 'measuredValue', toHundredths(value), endpoint.log);
      });
    },
  };
}

/**
 * Create a pressure sensor feature
 *
 * Homey reports mbar, which equals hPa, the unit of the Matter measured value.
 *
 * @param {string} capabilityId The capability, e.g. measure_pressure.
 * @returns {Feature} The feature.
 */
function pressureFeature(capabilityId: string): Feature {
  const toMatter = (value: HomeyCapabilityValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [pressureSensor],
    clusters: ['PressureMeasurement'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultPressureMeasurementClusterServer(toMatter(context.value(capabilityId)));
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(PressureMeasurement, 'measuredValue', toMatter(value), endpoint.log);
      });
    },
  };
}

/**
 * Create a light sensor feature
 *
 * @param {string} capabilityId The capability, e.g. measure_luminance (lux).
 * @returns {Feature} The feature.
 */
function illuminanceFeature(capabilityId: string): Feature {
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [lightSensor],
    clusters: ['IlluminanceMeasurement'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultIlluminanceMeasurementClusterServer(luxToMatter(context.value(capabilityId)));
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(IlluminanceMeasurement, 'measuredValue', luxToMatter(value), endpoint.log);
      });
    },
  };
}

/**
 * Create an occupancy sensor feature
 *
 * @param {string} capabilityId The capability, e.g. alarm_motion, alarm_occupancy or alarm_presence.
 * @returns {Feature} The feature.
 */
function occupancyFeature(capabilityId: string): Feature {
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [occupancySensor],
    clusters: ['OccupancySensing'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultOccupancySensingClusterServer(context.value(capabilityId) === true);
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(OccupancySensing, 'occupancy', { occupied: value === true }, endpoint.log);
      });
    },
  };
}

/**
 * Create a contact sensor feature
 *
 * Homey alarm_contact is true when open, Matter BooleanState stateValue is true when closed.
 *
 * @param {string} capabilityId The capability, e.g. alarm_contact.
 * @returns {Feature} The feature.
 */
function contactFeature(capabilityId: string): Feature {
  return booleanStateFeature(capabilityId, contactSensor, (value) => value !== true);
}

/**
 * Create a rain sensor feature
 *
 * @param {string} capabilityId The capability, e.g. alarm_rain.
 * @returns {Feature} The feature.
 */
function rainFeature(capabilityId: string): Feature {
  return booleanStateFeature(capabilityId, rainSensor, (value) => value === true);
}

/**
 * Create a water leak detector feature
 *
 * @param {string} capabilityId The capability, e.g. alarm_water.
 * @returns {Feature} The feature.
 */
function waterLeakFeature(capabilityId: string): Feature {
  return booleanStateFeature(capabilityId, waterLeakDetector, (value) => value === true);
}

/**
 * Create a feature based on the BooleanState cluster
 *
 * @param {string} capabilityId The boolean capability.
 * @param {DeviceTypeDefinition} deviceType The Matter device type.
 * @param {(value: HomeyCapabilityValue | undefined) => boolean} toState Converts the Homey value to the BooleanState stateValue.
 * @returns {Feature} The feature.
 */
function booleanStateFeature(capabilityId: string, deviceType: DeviceTypeDefinition, toState: (value: HomeyCapabilityValue | undefined) => boolean): Feature {
  return {
    name: capabilityId,
    capabilities: [capabilityId],
    deviceTypes: [deviceType],
    clusters: ['BooleanState'],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultBooleanStateClusterServer(toState(context.value(capabilityId)));
      context.bind(capabilityId, async (value) => {
        await endpoint.updateAttribute(BooleanState, 'stateValue', toState(value), endpoint.log);
      });
    },
  };
}

/**
 * Create a smoke and/or CO alarm feature
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function smokeCoAlarmFeature(device: HomeyDevice): Feature {
  const hasSmoke = hasCapability(device, 'alarm_smoke');
  const hasCo = hasCapability(device, 'alarm_co');
  const alarmState = (value: HomeyCapabilityValue | undefined): SmokeCoAlarm.AlarmState => (value === true ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal);
  return {
    name: 'smokecoalarm',
    capabilities: ['alarm_smoke', 'alarm_co'],
    deviceTypes: [smokeCoAlarm],
    clusters: ['SmokeCoAlarm'],
    build: (context) => {
      const { endpoint } = context;
      if (hasSmoke && hasCo) endpoint.createDefaultSmokeCOAlarmClusterServer(alarmState(context.value('alarm_smoke')), alarmState(context.value('alarm_co')));
      else if (hasSmoke) endpoint.createSmokeOnlySmokeCOAlarmClusterServer(alarmState(context.value('alarm_smoke')));
      else endpoint.createCoOnlySmokeCOAlarmClusterServer(alarmState(context.value('alarm_co')));
      if (hasSmoke) {
        context.bind('alarm_smoke', async (value) => {
          await endpoint.updateAttribute(SmokeCoAlarm, 'smokeState', alarmState(value), endpoint.log);
        });
      }
      if (hasCo) {
        context.bind('alarm_co', async (value) => {
          await endpoint.updateAttribute(SmokeCoAlarm, 'coState', alarmState(value), endpoint.log);
        });
      }
    },
  };
}

/**
 * Create an air quality sensor feature with a concentration measurement for each Homey capability
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function airQualityFeature(device: HomeyDevice): Feature {
  const measurements = [
    { capabilityId: 'measure_co2', cluster: CarbonDioxideConcentrationMeasurement.id, name: 'CarbonDioxideConcentrationMeasurement' },
    { capabilityId: 'measure_co', cluster: CarbonMonoxideConcentrationMeasurement.id, name: 'CarbonMonoxideConcentrationMeasurement' },
    { capabilityId: 'measure_pm25', cluster: Pm25ConcentrationMeasurement.id, name: 'Pm25ConcentrationMeasurement' },
    { capabilityId: 'measure_pm10', cluster: Pm10ConcentrationMeasurement.id, name: 'Pm10ConcentrationMeasurement' },
    { capabilityId: 'measure_tvoc', cluster: TotalVolatileOrganicCompoundsConcentrationMeasurement.id, name: 'TotalVolatileOrganicCompoundsConcentrationMeasurement' },
  ].filter((measurement) => hasCapability(device, measurement.capabilityId));
  const toMatter = (value: HomeyCapabilityValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  return {
    name: 'airquality',
    capabilities: measurements.map((measurement) => measurement.capabilityId),
    deviceTypes: [airQualitySensor],
    clusters: ['AirQuality', ...measurements.map((measurement) => measurement.name)],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultAirQualityClusterServer(AirQuality.AirQualityEnum.Unknown);
      for (const { capabilityId, cluster } of measurements) {
        const value = toMatter(context.value(capabilityId));
        if (capabilityId === 'measure_co2') endpoint.createDefaultCarbonDioxideConcentrationMeasurementClusterServer(value);
        if (capabilityId === 'measure_co') endpoint.createDefaultCarbonMonoxideConcentrationMeasurementClusterServer(value);
        if (capabilityId === 'measure_pm25') endpoint.createDefaultPm25ConcentrationMeasurementClusterServer(value);
        if (capabilityId === 'measure_pm10') endpoint.createDefaultPm10ConcentrationMeasurementClusterServer(value);
        if (capabilityId === 'measure_tvoc') endpoint.createDefaultTvocMeasurementClusterServer(value);
        context.bind(capabilityId, async (newValue) => {
          await endpoint.updateAttribute(cluster, 'measuredValue', toMatter(newValue), endpoint.log);
        });
      }
    },
  };
}

/**
 * Create an electrical sensor feature for power (W) and energy (kWh) measurements
 *
 * @param {HomeyDevice} device The Homey device.
 * @returns {Feature} The feature.
 */
function electricalFeature(device: HomeyDevice): Feature {
  const hasPower = hasCapability(device, 'measure_power');
  const hasEnergy = hasCapability(device, 'meter_power');
  const toMilliwattHours = (value: HomeyCapabilityValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000_000) : null);
  return {
    name: 'electrical',
    capabilities: ['measure_power', 'meter_power', 'measure_voltage', 'measure_current'],
    deviceTypes: [electricalSensor],
    clusters: ['PowerTopology', ...(hasPower ? ['ElectricalPowerMeasurement'] : []), ...(hasEnergy ? ['ElectricalEnergyMeasurement'] : [])],
    build: (context) => {
      const { endpoint } = context;
      endpoint.createDefaultPowerTopologyClusterServer();
      if (hasPower) {
        endpoint.createDefaultElectricalPowerMeasurementClusterServer(
          toThousandths(context.value('measure_voltage')),
          toThousandths(context.value('measure_current')),
          toThousandths(context.value('measure_power')),
        );
        context.bind('measure_power', async (value) => {
          await endpoint.updateAttribute(ElectricalPowerMeasurement, 'activePower', toThousandths(value), endpoint.log);
        });
        if (hasCapability(device, 'measure_voltage')) {
          context.bind('measure_voltage', async (value) => {
            await endpoint.updateAttribute(ElectricalPowerMeasurement, 'voltage', toThousandths(value), endpoint.log);
          });
        }
        if (hasCapability(device, 'measure_current')) {
          context.bind('measure_current', async (value) => {
            await endpoint.updateAttribute(ElectricalPowerMeasurement, 'activeCurrent', toThousandths(value), endpoint.log);
          });
        }
      }
      if (hasEnergy) {
        endpoint.createImportedElectricalEnergyMeasurementClusterServer(toMilliwattHours(context.value('meter_power')));
        context.bind('meter_power', async (value) => {
          const energy = toMilliwattHours(value);
          if (energy !== null) await endpoint.updateAttribute(ElectricalEnergyMeasurement, 'cumulativeEnergyImported', { energy }, endpoint.log);
        });
      }
    },
  };
}
