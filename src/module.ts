/**
 * @file src/module.ts
 * @description Matterbridge dynamic platform that exposes the devices of a Homey Pro to Matter.
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

import { type BasePlatformConfig, MatterbridgeDynamicPlatform, type PlatformMatterbridge, roboticVacuumCleaner } from 'matterbridge';
import { type AnsiLogger, CYAN, db, idn, type LogLevel, nf, rs, wr } from 'matterbridge/logger';
import { fireAndForget, getErrorMessage, inspectError, isValidArray, isValidObject, isValidString } from 'matterbridge/utils';

import { getExposedCapabilities } from './features.js';
import { HomeyApiConnection, type HomeyConnection, type HomeyDevice, type HomeyZone } from './homey.js';
import { getSerialNumber, HomeyBridgedDevice } from './homeyDevice.js';

/** Configuration of the Homey platform. */
export type HomeyPlatformConfig = BasePlatformConfig & {
  /** Local address of the Homey Pro, e.g. http://192.168.1.50. */
  address: string;
  /** Homey API key. */
  token: string;
  /** Device names or IDs to expose. Empty exposes all devices. */
  whiteList: string[];
  /** Device names or IDs not to expose. */
  blackList: string[];
  /** Zone names whose devices (including sub-zones) are exposed. Empty exposes all zones. */
  zoneWhiteList: string[];
  /** Devices (names or IDs) exposed as lights, whatever their Homey class. */
  lightList: string[];
  /** Devices (names or IDs) exposed as plugs, whatever their Homey class. */
  outletList: string[];
  /** Capabilities not exposed for any device, e.g. meter_power. */
  capabilityBlackList: string[];
  /** Capabilities not exposed per device: device name or ID -> capability IDs. */
  deviceCapabilityBlackList: Record<string, string[]>;
  /** Expose the devices added to Homey while the plugin runs, without a restart. */
  exposeNewDevices: boolean;
};

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {HomeyPlatformConfig} config - The platform configuration.
 * @returns {HomeyPlatform} - An instance of the HomeyPlatform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HomeyPlatformConfig): HomeyPlatform {
  return new HomeyPlatform(matterbridge, log, config);
}

/**
 * Give every device a unique name: devices with the same name get their zone name appended, e.g. "Ceiling light Kitchen"
 *
 * @param {HomeyDevice[]} devices The Homey devices.
 * @param {HomeyZone[]} zones The Homey zones.
 * @returns {Map<string, string>} The unique name per device ID.
 */
export function getUniqueDeviceNames(devices: HomeyDevice[], zones: HomeyZone[]): Map<string, string> {
  const zoneNames = new Map(zones.map((zone) => [zone.id, zone.name]));
  const count = (names: string[], name: string): number => names.filter((candidate) => candidate.toLowerCase() === name.toLowerCase()).length;
  const baseNames = devices.map((device) => device.name.trim() || device.id);
  const zonedNames = devices.map((device, index) => {
    const zoneName = device.zone ? zoneNames.get(device.zone) : undefined;
    return count(baseNames, baseNames[index]) > 1 && zoneName ? `${baseNames[index]} ${zoneName}` : baseNames[index];
  });
  const names = new Map<string, string>();
  devices.forEach((device, index) => {
    names.set(device.id, count(zonedNames, zonedNames[index]) > 1 ? `${zonedNames[index]} ${device.id.slice(0, 4)}` : zonedNames[index]);
  });
  return names;
}

/**
 * Customize a Homey device for Matter: change its device class and remove capabilities
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {string | undefined} deviceClass The device class to use, or undefined to keep the class of the device.
 * @param {Set<string>} excludedCapabilities The capabilities to remove.
 * @returns {HomeyDevice} A customized copy of the device, or the device itself when nothing changes.
 */
export function customizeDevice(device: HomeyDevice, deviceClass: string | undefined, excludedCapabilities: Set<string>): HomeyDevice {
  if (deviceClass === undefined && !device.capabilities.some((capabilityId) => excludedCapabilities.has(capabilityId))) return device;
  const capabilitiesObj = device.capabilitiesObj
    ? Object.fromEntries(Object.entries(device.capabilitiesObj).filter(([capabilityId]) => !excludedCapabilities.has(capabilityId)))
    : device.capabilitiesObj;
  return {
    ...device,
    virtualClass: deviceClass ?? device.virtualClass,
    capabilities: device.capabilities.filter((capabilityId) => !excludedCapabilities.has(capabilityId)),
    capabilitiesObj,
  };
}

/**
 * Check whether a device is in one of the zones (or one of their sub-zones)
 *
 * @param {HomeyDevice} device The Homey device.
 * @param {HomeyZone[]} zones The Homey zones.
 * @param {string[]} zoneNames The zone names to match, case-insensitive. Empty matches all devices.
 * @returns {boolean} True when the device is in one of the zones.
 */
export function isInZones(device: HomeyDevice, zones: HomeyZone[], zoneNames: string[]): boolean {
  if (zoneNames.length === 0) return true;
  const wanted = new Set(zoneNames.map((name) => name.trim().toLowerCase()));
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
  const visited = new Set<string>();
  let zone = device.zone ? zonesById.get(device.zone) : undefined;
  while (zone && !visited.has(zone.id)) {
    if (wanted.has(zone.name.trim().toLowerCase())) return true;
    visited.add(zone.id);
    zone = zone.parent ? zonesById.get(zone.parent) : undefined;
  }
  return false;
}

/**
 * Matterbridge dynamic platform that exposes the devices of a Homey Pro to Matter.
 */
export class HomeyPlatform extends MatterbridgeDynamicPlatform {
  /** The connection to the Homey. */
  readonly homey: HomeyConnection;
  /** The registered devices by Homey device ID. */
  readonly bridgedDevices = new Map<string, HomeyBridgedDevice>();
  /** The Homey zones, for the device names. */
  private zones: HomeyZone[] = [];
  /** Devices added to Homey while the plugin runs that aren't exposed yet. Homey can complete a new device after creating it, so they are tried again when they change. */
  private readonly newDeviceIds = new Set<string>();
  /** Whether onConfigure applied the Homey state to the devices and subscribed them: the devices exposed later do it themselves. */
  private areDevicesConfigured = false;
  /** The device changes in progress, applied one at a time in the order Homey sent them. */
  private deviceChanges: Promise<void> = Promise.resolve();

  /**
   * Create the Homey platform
   *
   * @param {PlatformMatterbridge} matterbridge The Matterbridge instance.
   * @param {AnsiLogger} log The logger.
   * @param {HomeyPlatformConfig} config The platform configuration.
   * @param {HomeyConnection} [homey] The Homey connection. Defaults to a connection with the configured address and API key.
   * @throws {Error} When Matterbridge is too old or the address or API key is missing.
   */
  constructor(
    matterbridge: PlatformMatterbridge,
    log: AnsiLogger,
    override config: HomeyPlatformConfig,
    homey?: HomeyConnection,
  ) {
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.10.10')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.10.10". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info(`Initializing platform ${CYAN}${this.config.name}${nf} version ${CYAN}${this.config.version}${rs}`);

    if (!homey && (!isValidString(config.address, 1) || !isValidString(config.token, 1))) {
      setImmediate(() => fireAndForget(this.onShutdown('Invalid configuration'), this.log, 'onShutdown'));
      this.wssSendSnackbarMessage('Homey plugin: configure the Homey address and API key', 0, 'error');
      throw new Error('The Homey address and API key must be set in the configuration');
    }

    this.config.whiteList = isValidArray(config.whiteList) ? config.whiteList : [];
    this.config.blackList = isValidArray(config.blackList) ? config.blackList : [];
    this.config.zoneWhiteList = isValidArray(config.zoneWhiteList) ? config.zoneWhiteList : [];
    this.config.lightList = isValidArray(config.lightList) ? config.lightList : [];
    this.config.outletList = isValidArray(config.outletList) ? config.outletList : [];
    this.config.capabilityBlackList = isValidArray(config.capabilityBlackList) ? config.capabilityBlackList : [];
    this.config.deviceCapabilityBlackList = isValidObject(config.deviceCapabilityBlackList) ? config.deviceCapabilityBlackList : {};
    this.config.exposeNewDevices ??= true;
    this.config.debug ??= false;
    this.config.unregisterOnShutdown ??= false;

    this.homey =
      homey ?? new HomeyApiConnection(config.address, config.token, 15000, config.debug ? (message: string): void => this.log.debug(`[homey-api] ${message}`) : undefined);
    this.homey.on('device.create', (device: HomeyDevice) => {
      if (!this.config.exposeNewDevices) {
        this.log.notice(`New Homey device ${CYAN}${device.name}${nf}: restart Matterbridge to expose it`);
        if (this.isConfigured) this.wssSendRestartRequired();
        return;
      }
      this.log.notice(`New Homey device ${CYAN}${device.name}${nf}`);
      fireAndForget(
        this.serialize(async () => this.addNewDevice(device)),
        this.log,
        `addition of ${device.name}`,
      );
    });
    this.homey.on('device.update', (device: HomeyDevice) => {
      fireAndForget(
        this.serialize(async () => this.updateDevice(device)),
        this.log,
        `update of ${device.name}`,
      );
    });
    this.homey.on('device.delete', (device: HomeyDevice) => {
      fireAndForget(
        this.serialize(async () => this.removeDevice(device.id)),
        this.log,
        `removal of ${device.id}`,
      );
    });
    this.homey.on('disconnected', () => {
      this.log.warn('Disconnected from Homey');
      for (const bridgedDevice of this.bridgedDevices.values()) fireAndForget(bridgedDevice.setReachable(false), this.log, 'setReachable');
    });
    this.homey.on('reconnected', () => {
      this.log.notice('Reconnected to Homey');
      for (const bridgedDevice of this.bridgedDevices.values()) fireAndForget(bridgedDevice.setReachable(bridgedDevice.device.available !== false), this.log, 'setReachable');
    });

    this.log.info(`Initialized platform ${CYAN}${this.config.name}${nf} version ${CYAN}${this.config.version}${rs}`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting platform ${idn}${this.config.name}${rs}${nf}: ${reason ?? ''}`);
    await this.ready;
    await this.clearSelect();

    this.log.info(`Connecting to Homey at ${CYAN}${this.config.address}${nf}...`);
    try {
      await this.homey.connect();
    } catch (error) {
      this.wssSendSnackbarMessage('Homey plugin: unable to connect to Homey, check the address and API key', 0, 'error');
      throw new Error(`Unable to connect to Homey at ${this.config.address}: ${getErrorMessage(error)}`, { cause: error });
    }
    this.log.notice(`Connected to Homey ${CYAN}${this.homey.homeyId ?? ''}${nf}`);

    // The device events that arrive meanwhile wait until the devices are registered.
    await this.serialize(async () => {
      const [devices, zones] = await Promise.all([this.homey.getDevices(), this.homey.getZones()]);
      this.zones = zones;
      this.log.info(`Found ${CYAN}${devices.length}${nf} devices in ${CYAN}${zones.length}${nf} zones`);
      const names = getUniqueDeviceNames(devices, zones);
      for (const device of devices.toSorted((a, b) => a.name.localeCompare(b.name))) {
        await this.addDevice(device, names.get(device.id) ?? device.name, zones);
      }
    });
    this.log.info(`Started platform ${idn}${this.config.name}${rs}${nf} with ${CYAN}${this.bridgedDevices.size}${nf} devices`);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info(`Configuring platform ${idn}${this.config.name}${rs}${nf}...`);
    await this.serialize(async () => {
      for (const bridgedDevice of this.bridgedDevices.values()) {
        await bridgedDevice.applyAll();
        bridgedDevice.subscribe();
      }
      this.areDevicesConfigured = true;
    });
    this.log.info(`Configured platform ${idn}${this.config.name}${rs}${nf}`);
  }

  // oxlint-disable-next-line typescript/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`Logger level changed to ${logLevel}`);
    for (const bridgedDevice of this.bridgedDevices.values()) {
      bridgedDevice.endpoint.log.logLevel = logLevel;
      for (const child of bridgedDevice.endpoint.getChildEndpoints()) child.log.logLevel = logLevel;
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`Shutting down platform ${idn}${this.config.name}${rs}${nf}: ${reason ?? ''}`);
    for (const bridgedDevice of this.bridgedDevices.values()) bridgedDevice.unsubscribe();
    try {
      await this.homey?.close();
      this.homey?.removeAllListeners();
    } catch (error) {
      inspectError(this.log, 'Error closing the Homey connection', error);
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
    this.bridgedDevices.clear();
    this.log.info(`Shut down platform ${idn}${this.config.name}${rs}${nf}`);
  }

  /**
   * Create and register the Matter device of a Homey device, when it is supported and selected
   *
   * @param {HomeyDevice} device The Homey device.
   * @param {string} name The unique Matter device name.
   * @param {HomeyZone[]} zones The Homey zones, for the zone filter.
   * @returns {Promise<void>} Resolves when the device is registered or skipped.
   */
  private async addDevice(device: HomeyDevice, name: string, zones: HomeyZone[]): Promise<void> {
    // The device can be referred to by its Matter name, its Homey name, its Homey ID or its serial number.
    const serial = getSerialNumber(device.id);
    const keys = [name, device.name, device.id, serial];
    const isListed = (list: string[]): boolean => keys.some((key) => list.includes(key));
    const deviceClass = isListed(this.config.lightList) ? 'light' : isListed(this.config.outletList) ? 'socket' : undefined;
    const remapped = customizeDevice(device, deviceClass, new Set());
    const exposedCapabilities = device.capabilitiesObj ? getExposedCapabilities(remapped) : [];
    if (exposedCapabilities.length === 0) {
      this.log.debug(`Device ${CYAN}${device.name}${db} class ${CYAN}${remapped.virtualClass ?? remapped.class}${db} has no capabilities Matter supports. Skipping...`);
      return;
    }
    if (!isInZones(device, zones, this.config.zoneWhiteList)) {
      this.log.info(`Device ${CYAN}${name}${nf} is not in the zones ${CYAN}${this.config.zoneWhiteList.join(', ')}${nf}. Skipping...`);
      return;
    }
    // Offer the device and the capabilities it exposes in the pickers of the frontend, including the excluded ones.
    const configUrl = this.homey.homeyId ? `https://my.homey.app/homeys/${this.homey.homeyId}/devices/${device.id}` : undefined;
    const entities = exposedCapabilities.map((capabilityId) => ({ name: capabilityId, description: device.capabilitiesObj?.[capabilityId]?.title ?? capabilityId }));
    for (const entity of entities) this.setSelectEntity(entity.name, entity.description, 'component');
    // The picker serial must be the serial number of the Matter device, or the frontend lists the device twice.
    this.setSelectDevice(serial, name, configUrl, 'hub', entities);
    if (!this.validateDevice(keys)) return;

    const excludedCapabilities = new Set([...this.config.capabilityBlackList, ...keys.flatMap((key) => this.config.deviceCapabilityBlackList[key] ?? [])]);
    // A device that fails to build or register is skipped, so it doesn't stop the plugin from starting.
    try {
      const bridgedDevice = HomeyBridgedDevice.create({
        device: customizeDevice(remapped, undefined, excludedCapabilities),
        name,
        connection: this.homey,
        vendorId: this.matterbridge.aggregatorVendorId,
        logLevel: this.log.logLevel,
        configUrl,
      });
      if (!bridgedDevice) {
        this.log.info(`Device ${CYAN}${name}${nf} has no capabilities left after the capability black lists. Skipping...`);
        return;
      }
      this.log.info(`Registering device ${idn}${name}${rs}${nf} class ${CYAN}${remapped.virtualClass ?? remapped.class}${nf}...`);
      await this.registerDevice(bridgedDevice.endpoint);
      this.bridgedDevices.set(device.id, bridgedDevice);
      if (bridgedDevice.endpoint.deviceTypes.has(roboticVacuumCleaner.code)) {
        this.log.warn(`Device ${CYAN}${name}${wr} is a robotic vacuum cleaner: Apple Home doesn't support it in a bridge. If you use Apple Home, add it to the black list.`);
      }
    } catch (error) {
      inspectError(this.log, `Failed to register device ${name}`, error);
    }
  }

  /**
   * Expose a device that was added to Homey while the plugin runs
   *
   * Names are unique across all the Homey devices, like on start, so the new device can change the zone suffix of other devices too.
   *
   * @param {HomeyDevice} device The new Homey device.
   * @returns {Promise<void>} Resolves when the device is exposed or skipped.
   */
  private async addNewDevice(device: HomeyDevice): Promise<void> {
    if (this.bridgedDevices.has(device.id)) return;
    const [devices, zones] = await Promise.all([this.homey.getDevices(), this.homey.getZones()]);
    this.zones = zones;
    const names = getUniqueDeviceNames([...devices.filter((other) => other.id !== device.id), device], zones);
    // Rename the other devices first: the new device can get the current name of one of them.
    for (const [deviceId, bridged] of this.bridgedDevices) await bridged.setName(names.get(deviceId) ?? bridged.device.name);
    await this.addDevice(device, names.get(device.id) ?? device.name, zones);
    const bridgedDevice = this.bridgedDevices.get(device.id);
    if (!bridgedDevice) {
      this.newDeviceIds.add(device.id);
      return;
    }
    this.newDeviceIds.delete(device.id);
    // Before onConfigure, onConfigure applies the Homey state and subscribes.
    if (!this.areDevicesConfigured) return;
    await bridgedDevice.applyAll();
    bridgedDevice.subscribe();
  }

  /**
   * Update the Matter device of a Homey device that changed, e.g. its availability or its name
   *
   * Names are unique across all the Homey devices, so a rename can change the zone suffix of other devices too.
   * A new device that isn't exposed yet is tried again.
   *
   * @param {HomeyDevice} device The updated Homey device.
   * @returns {Promise<void>} Resolves when the Matter devices are updated.
   */
  private async updateDevice(device: HomeyDevice): Promise<void> {
    const bridgedDevice = this.bridgedDevices.get(device.id);
    if (!bridgedDevice) {
      if (this.newDeviceIds.has(device.id)) await this.addNewDevice(device);
      return;
    }
    const isRenamed = device.name !== bridgedDevice.homeyName;
    await bridgedDevice.update(device);
    if (!isRenamed) return;
    const names = getUniqueDeviceNames(await this.homey.getDevices(), this.zones);
    for (const [deviceId, bridged] of this.bridgedDevices) await bridged.setName(names.get(deviceId) ?? bridged.device.name);
  }

  /**
   * Remove the Matter device of a Homey device that was deleted
   *
   * @param {string} deviceId The Homey device ID.
   * @returns {Promise<void>} Resolves when the device is unregistered.
   */
  private async removeDevice(deviceId: string): Promise<void> {
    this.newDeviceIds.delete(deviceId);
    const bridgedDevice = this.bridgedDevices.get(deviceId);
    if (!bridgedDevice) return;
    this.log.notice(`Homey device ${CYAN}${bridgedDevice.device.name}${nf} was deleted: removing it`);
    bridgedDevice.unsubscribe();
    this.bridgedDevices.delete(deviceId);
    await this.unregisterDevice(bridgedDevice.endpoint);
  }

  /**
   * Run a device change after the changes in progress, so a device can't be registered twice or removed while it's registered
   *
   * @param {() => Promise<void>} change The device change.
   * @returns {Promise<void>} Resolves or rejects with the change.
   */
  private async serialize(change: () => Promise<void>): Promise<void> {
    const result = this.deviceChanges.then(change);
    this.deviceChanges = result.catch(() => {
      // The caller gets the error, and the next change runs anyway.
    });
    await result;
  }
}
