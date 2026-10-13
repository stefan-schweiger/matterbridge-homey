/**
 * @file src/homeyDevice.ts
 * @description A Homey device exposed as a Matter bridged device.
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

import { createHash } from 'node:crypto';

import { type DeviceTypeDefinition, MatterbridgeEndpoint, powerSource } from 'matterbridge';
import { CYAN, db, er, type LogLevel, nf, YELLOW } from 'matterbridge/logger';
import { BridgedDeviceBasicInformationServer } from 'matterbridge/matter/behaviors';
import { BridgedDeviceBasicInformation, PowerSource } from 'matterbridge/matter/clusters';
import { getErrorMessage } from 'matterbridge/utils';

import { batteryToMatter, ellipsize } from './converters.js';
import { type CapabilityUpdate, type Feature, type FeatureContext, getDeviceClass, hasCapability, planFeatures } from './features.js';
import type { HomeyCapabilityValue, HomeyConnection, HomeyDevice } from './homey.js';

/** Options to create a {@link HomeyBridgedDevice}. */
export interface HomeyBridgedDeviceOptions {
  /** The Homey device. */
  device: HomeyDevice;
  /** The Matter device name, unique within the bridge. */
  name: string;
  /** The Homey connection used to set capability values and listen to their changes. */
  connection: HomeyConnection;
  /** The Matter vendor ID of the bridge. */
  vendorId: number;
  /** The log level of the device logger. */
  logLevel: LogLevel;
  /** Optional https URL of the device in the Homey web app. */
  configUrl?: string;
}

/**
 * Create the Matter unique ID of a Homey device
 *
 * The Matter UniqueID of a bridged device must not change. Matterbridge derives it from the device name, which changes
 * when the device is renamed in Homey, so the plugin derives it from the Homey device ID instead.
 *
 * @param {string} deviceId The Homey device ID.
 * @returns {string} The unique ID (32 hexadecimal characters).
 */
export function createStableUniqueId(deviceId: string): string {
  return createHash('md5').update(`matterbridge-homey:${deviceId}`).digest('hex');
}

/**
 * Get the Matter serial number of a Homey device
 *
 * The Homey device ID without dashes: a UUID has 32 hexadecimal digits, the maximum length of a Matter serial number.
 * The same serial is used for the device picker of the frontend, which matches its entries with the registered devices.
 *
 * @param {string} deviceId The Homey device ID.
 * @returns {string} The serial number.
 */
export function getSerialNumber(deviceId: string): string {
  return deviceId.replaceAll('-', '').slice(0, 32);
}

/**
 * Split the features of a device into those on the device endpoint and those that need their own child endpoint
 *
 * A feature gets a child endpoint when it needs one (sub-capabilities) or when it uses a cluster that a feature on the
 * device endpoint already uses, e.g. a second occupancy sensor.
 *
 * @param {Feature[]} features The features, the main function first.
 * @returns {{ main: Feature[]; children: Feature[] }} The features of the device endpoint and of the child endpoints.
 */
export function splitFeatures(features: Feature[]): { main: Feature[]; children: Feature[] } {
  const main: Feature[] = [];
  const children: Feature[] = [];
  const usedClusters = new Set<string>();
  for (const feature of features) {
    if (!feature.ownEndpoint && feature.clusters.every((cluster) => !usedClusters.has(cluster))) {
      main.push(feature);
      for (const cluster of feature.clusters) usedClusters.add(cluster);
    } else {
      children.push(feature);
    }
  }
  // A device with only sub-capabilities, e.g. a double socket with onoff.output1 and onoff.output2.
  const first = children.shift();
  if (main.length === 0 && first) main.push(first);
  else if (first) children.unshift(first);
  return { main, children };
}

/**
 * A Homey device exposed as a Matter bridged device.
 *
 * The device endpoint holds the main function of the device and as many of its sensors as possible, so controllers
 * show it as one device. Features that can't share the device endpoint get a child endpoint.
 */
export class HomeyBridgedDevice {
  /** The Matter endpoint to register. */
  readonly endpoint: MatterbridgeEndpoint;
  /** Homey -> Matter updates per capability. */
  private readonly bindings = new Map<string, CapabilityUpdate[]>();
  /** Last known Homey value per capability. */
  private readonly values = new Map<string, HomeyCapabilityValue>();
  private readonly unsubscribers: (() => void)[] = [];
  /** The name of the device in Homey when it was last seen, to detect renames. */
  homeyName: string;
  /** The Matter device name (node label). */
  private name: string;

  private constructor(
    readonly device: HomeyDevice,
    private readonly connection: HomeyConnection,
    endpoint: MatterbridgeEndpoint,
    name: string,
  ) {
    this.endpoint = endpoint;
    this.name = name;
    this.homeyName = device.name;
    for (const [capabilityId, capability] of Object.entries(device.capabilitiesObj ?? {})) {
      if (capability.value !== undefined) this.values.set(capabilityId, capability.value);
    }
  }

  /**
   * Create the Matter endpoint of a Homey device
   *
   * @param {HomeyBridgedDeviceOptions} options The options.
   * @returns {HomeyBridgedDevice | undefined} The bridged device, or undefined when the device has nothing that can be exposed to Matter.
   */
  static create(options: HomeyBridgedDeviceOptions): HomeyBridgedDevice | undefined {
    const { device, name } = options;
    const { main, children } = splitFeatures(planFeatures(device));
    if (main.length === 0) return undefined;
    const hasBattery = hasCapability(device, 'measure_battery') || hasCapability(device, 'alarm_battery');
    const deviceTypes = uniqueDeviceTypes([...main.flatMap((feature) => feature.deviceTypes), ...(hasBattery ? [powerSource] : [])]);

    const endpoint = new MatterbridgeEndpoint(deviceTypes, { id: device.id }).createDefaultBridgedDeviceBasicInformationClusterServer(
      ellipsize(name),
      getSerialNumber(device.id),
      options.vendorId,
      'Homey',
      ellipsize(`Homey ${getDeviceClass(device)}`),
      1,
      '1.0.0',
      1,
      '1.0.0',
      'Homey device',
      options.configUrl,
    );
    endpoint.log.logLevel = options.logLevel;
    // The link of the device in the Devices list of the frontend.
    endpoint.configUrl = options.configUrl;
    // Replace the name based unique ID of Matterbridge before the endpoint is registered: the cluster reads its options then.
    const uniqueId = createStableUniqueId(device.id);
    endpoint.uniqueId = uniqueId;
    const basicInformation = endpoint.behaviors.optionsFor(BridgedDeviceBasicInformationServer);
    if (basicInformation) Object.assign(basicInformation, { uniqueId });
    const bridgedDevice = new HomeyBridgedDevice(device, options.connection, endpoint, ellipsize(name));

    for (const feature of main) feature.build(bridgedDevice.createContext(endpoint));
    if (hasBattery) bridgedDevice.buildBattery();
    endpoint.addRequiredClusters();

    for (const feature of children) {
      const child = endpoint.addChildDeviceType(feature.name, uniqueDeviceTypes(feature.deviceTypes));
      child.log.logLevel = options.logLevel;
      feature.build(bridgedDevice.createContext(child));
      child.addRequiredClusters();
    }
    return bridgedDevice;
  }

  /**
   * The Homey capabilities the Matter device reflects
   *
   * @returns {string[]} The capability IDs.
   */
  get capabilityIds(): string[] {
    return [...this.bindings.keys()].filter((capabilityId) => hasCapability(this.device, capabilityId));
  }

  /**
   * Apply the name, the last known Homey values and the availability to the Matter state
   *
   * Applied once the device is registered, so the Matter state matches Homey even where the stored state of the
   * endpoint differs from the state it was created with.
   *
   * @returns {Promise<void>} Resolves when applied.
   */
  async applyAll(): Promise<void> {
    await this.endpoint.updateAttribute(BridgedDeviceBasicInformation, 'nodeLabel', this.name, this.endpoint.log);
    for (const capabilityId of this.capabilityIds) {
      const value = this.values.get(capabilityId);
      if (value !== undefined) await this.apply(capabilityId, value);
    }
    await this.setReachable(this.device.available !== false);
  }

  /**
   * Listen to the realtime capability changes of the device
   */
  subscribe(): void {
    this.unsubscribe();
    for (const capabilityId of this.capabilityIds) {
      try {
        this.unsubscribers.push(
          this.connection.subscribeCapability(this.device.id, capabilityId, (value) => {
            this.endpoint.log.debug(`Homey capability ${CYAN}${capabilityId}${db} changed to ${YELLOW}${String(value)}${db}`);
            this.values.set(capabilityId, value);
            void this.apply(capabilityId, value);
          }),
        );
      } catch (error) {
        this.endpoint.log.error(`Failed to listen to capability ${CYAN}${capabilityId}${er}: ${getErrorMessage(error)}`);
      }
    }
  }

  /**
   * Stop listening to the realtime capability changes of the device
   */
  unsubscribe(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /**
   * Update the Homey device object, e.g. after its availability changed
   *
   * @param {HomeyDevice} device The updated Homey device.
   * @returns {Promise<void>} Resolves when the Matter state is updated.
   */
  async update(device: HomeyDevice): Promise<void> {
    this.device.available = device.available;
    this.device.name = device.name;
    await this.setReachable(device.available !== false);
  }

  /**
   * Change the Matter device name, e.g. after the device was renamed in Homey
   *
   * The unique ID doesn't change, so controllers keep the device and only its name changes.
   *
   * @param {string} name The new name.
   * @returns {Promise<void>} Resolves when the node label is updated.
   */
  async setName(name: string): Promise<void> {
    this.homeyName = this.device.name;
    const nodeLabel = ellipsize(name);
    if (nodeLabel === this.name) return;
    this.endpoint.log.notice(`Renaming device ${CYAN}${this.name}${nf} to ${CYAN}${nodeLabel}${nf}`);
    this.name = nodeLabel;
    this.endpoint.deviceName = nodeLabel;
    this.endpoint.log.logName = nodeLabel;
    await this.endpoint.updateAttribute(BridgedDeviceBasicInformation, 'nodeLabel', nodeLabel, this.endpoint.log);
  }

  /**
   * Set whether the device is reachable
   *
   * @param {boolean} isReachable Whether the device is reachable.
   * @returns {Promise<void>} Resolves when the Matter state is updated.
   */
  async setReachable(isReachable: boolean): Promise<void> {
    await this.endpoint.updateAttribute(BridgedDeviceBasicInformation, 'reachable', isReachable, this.endpoint.log);
  }

  /**
   * Apply a Homey capability value to the Matter state
   *
   * @param {string} capabilityId The capability ID.
   * @param {HomeyCapabilityValue} value The value.
   * @returns {Promise<void>} Resolves when applied. Errors are logged.
   */
  private async apply(capabilityId: string, value: HomeyCapabilityValue): Promise<void> {
    for (const update of this.bindings.get(capabilityId) ?? []) {
      try {
        await update(value);
      } catch (error) {
        this.endpoint.log.error(`Failed to apply capability ${CYAN}${capabilityId}${er} value ${String(value)}: ${getErrorMessage(error)}`);
      }
    }
  }

  /**
   * Send a value to Homey
   *
   * The Matter command already changed the Matter state. When Homey rejects the value, the last value reported by Homey
   * is applied again. When Homey accepts it and `reflect` is set, it is applied to the Matter state like a value reported
   * by Homey (Homey doesn't echo it back), e.g. the current position of a window covering.
   *
   * Values are only reflected on request: writing to the endpoint while the Matter command that triggered the value is
   * still committing would make the command fail.
   *
   * @param {string} capabilityId The capability ID.
   * @param {HomeyCapabilityValue} value The value.
   * @param {boolean} reflect Whether to apply the accepted value to the Matter state.
   * @returns {Promise<void>} Resolves when done. Never rejects: errors are logged.
   */
  private async set(capabilityId: string, value: HomeyCapabilityValue, reflect: boolean): Promise<void> {
    this.endpoint.log.info(`Setting Homey capability ${CYAN}${capabilityId}${nf} to ${YELLOW}${String(value)}${nf}`);
    try {
      await this.connection.setCapabilityValue(this.device.id, capabilityId, value);
      this.values.set(capabilityId, value);
      if (reflect) await this.apply(capabilityId, value);
    } catch (error) {
      this.endpoint.log.error(`Failed to set Homey capability ${CYAN}${capabilityId}${er} to ${String(value)}: ${getErrorMessage(error)}`);
      const lastValue = this.values.get(capabilityId);
      if (lastValue !== undefined) await this.apply(capabilityId, lastValue);
    }
  }

  /**
   * Create the context to build a feature on an endpoint
   *
   * @param {MatterbridgeEndpoint} endpoint The device endpoint or a child endpoint.
   * @returns {FeatureContext} The context.
   */
  private createContext(endpoint: MatterbridgeEndpoint): FeatureContext {
    return {
      device: this.device,
      endpoint,
      value: (capabilityId) => this.values.get(capabilityId),
      set: (capabilityId, value, reflect = false) => void this.set(capabilityId, value, reflect),
      bind: (capabilityId, update) => {
        const updates = this.bindings.get(capabilityId) ?? [];
        updates.push(update);
        this.bindings.set(capabilityId, updates);
      },
    };
  }

  /**
   * Build the battery PowerSource cluster on the device endpoint
   */
  private buildBattery(): void {
    const { endpoint } = this;
    const hasAlarm = hasCapability(this.device, 'alarm_battery');
    const chargeLevel = (): PowerSource.BatChargeLevel => {
      if (hasAlarm) return this.values.get('alarm_battery') === true ? PowerSource.BatChargeLevel.Critical : PowerSource.BatChargeLevel.Ok;
      const percent = this.values.get('measure_battery');
      if (typeof percent !== 'number') return PowerSource.BatChargeLevel.Ok;
      if (percent <= 10) return PowerSource.BatChargeLevel.Critical;
      return percent <= 20 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok;
    };
    endpoint.createDefaultPowerSourceBatteryClusterServer(batteryToMatter(this.values.get('measure_battery')), chargeLevel(), null);
    const context = this.createContext(endpoint);
    context.bind('measure_battery', async (value) => {
      await endpoint.updateAttribute(PowerSource, 'batPercentRemaining', batteryToMatter(value), endpoint.log);
      await endpoint.updateAttribute(PowerSource, 'batChargeLevel', chargeLevel(), endpoint.log);
    });
    context.bind('alarm_battery', async () => {
      await endpoint.updateAttribute(PowerSource, 'batChargeLevel', chargeLevel(), endpoint.log);
    });
  }
}

/**
 * Remove duplicated device types, keeping the order
 *
 * @param {DeviceTypeDefinition[]} deviceTypes The device types.
 * @returns {[DeviceTypeDefinition, ...DeviceTypeDefinition[]]} The unique device types.
 * @throws {Error} When the list is empty.
 */
function uniqueDeviceTypes(deviceTypes: DeviceTypeDefinition[]): [DeviceTypeDefinition, ...DeviceTypeDefinition[]] {
  const [first, ...rest] = [...new Set(deviceTypes)];
  if (!first) throw new Error('A Matter endpoint needs at least one device type');
  return [first, ...rest];
}
