/**
 * @file src/homey.ts
 * @description Thin wrapper around the homey-api package to access a Homey Pro with an API key.
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

import { EventEmitter } from 'node:events';

/** A primitive Homey capability value. */
export type HomeyCapabilityValue = boolean | number | string | null;

/** A Homey capability as found in `device.capabilitiesObj`. */
export interface HomeyCapability {
  id: string;
  type?: 'boolean' | 'number' | 'string' | 'enum';
  value?: HomeyCapabilityValue;
  title?: string;
  getable?: boolean;
  setable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  units?: string;
  values?: { id: string; title?: unknown }[];
}

/** The subset of a Homey device object used by this plugin. */
export interface HomeyDevice {
  id: string;
  name: string;
  zone?: string | null;
  class: string;
  virtualClass?: string | null;
  capabilities: string[];
  capabilitiesObj?: Record<string, HomeyCapability> | null;
  available?: boolean;
  ready?: boolean;
  driverId?: string;
  ownerUri?: string;
}

/** The subset of a Homey zone object used by this plugin. */
export interface HomeyZone {
  id: string;
  name: string;
  parent?: string | null;
}

/** Listener for realtime capability value changes. */
export type CapabilityListener = (value: HomeyCapabilityValue) => void;

/**
 * Connection to a Homey. The platform depends on this interface only, so tests can provide a fake Homey.
 *
 * Events:
 *  - `device.create` (device: HomeyDevice): a device was added to Homey
 *  - `device.update` (device: HomeyDevice): a device changed, e.g. its availability or name
 *  - `device.delete` (device: HomeyDevice): a device was removed from Homey
 *  - `disconnected`: the realtime connection dropped
 *  - `reconnected`: the realtime connection is back
 */
export interface HomeyConnection extends EventEmitter {
  /** Homey ID, available after connect(). */
  readonly homeyId: string | undefined;
  /** Connect to the Homey and its realtime events. */
  connect(): Promise<void>;
  /** Get all devices. */
  getDevices(): Promise<HomeyDevice[]>;
  /** Get all zones. */
  getZones(): Promise<HomeyZone[]>;
  /** Set a capability value of a device. */
  setCapabilityValue(deviceId: string, capabilityId: string, value: HomeyCapabilityValue): Promise<void>;
  /** Listen to realtime value changes of a capability. Returns a function that stops listening. */
  subscribeCapability(deviceId: string, capabilityId: string, listener: CapabilityListener): () => void;
  /** Close the connection and stop all capability listeners. */
  close(): Promise<void>;
}

// The parts of the homey-api objects that are used. The package's own typings don't cover all of them.
interface HomeyApiCapabilityInstance {
  setValue(value: HomeyCapabilityValue): Promise<void>;
  destroy(): void;
}
interface HomeyApiDevice extends HomeyDevice {
  makeCapabilityInstance(capabilityId: string, listener: (value: HomeyCapabilityValue) => void): HomeyApiCapabilityInstance;
  setCapabilityValue(opts: { capabilityId: string; value: HomeyCapabilityValue }): Promise<unknown>;
}
interface HomeyApiManager extends EventEmitter {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
interface HomeyApi extends EventEmitter {
  id: string;
  devices: HomeyApiManager & { getDevices(): Promise<Record<string, HomeyApiDevice>> };
  zones: HomeyApiManager & { getZones(): Promise<Record<string, HomeyZone>> };
  destroy(): void;
}
interface HomeyApiModule {
  HomeyAPI: { createLocalAPI(opts: { address: string; token: string; debug?: ((...args: unknown[]) => void) | null }): Promise<HomeyApi> };
}

/**
 * Connection to a Homey Pro on the local network, authenticated with an API key.
 *
 * Realtime values are received through homey-api capability instances, which re-subscribe and refresh their values
 * by themselves after a reconnect. Values are written through the same instances, so Homey doesn't echo them back.
 */
export class HomeyApiConnection extends EventEmitter implements HomeyConnection {
  private api: HomeyApi | undefined;
  private readonly devices = new Map<string, HomeyApiDevice>();
  /** Capability instances keyed by `deviceId/capabilityId`. */
  private readonly capabilityInstances = new Map<string, HomeyApiCapabilityInstance>();

  /**
   * Create a connection to a Homey Pro
   *
   * @param {string} address Local address of the Homey Pro, e.g. http://192.168.1.50.
   * @param {string} token Homey API key.
   * @param {number} [timeout] Timeout in milliseconds to reach the Homey (default 15 seconds).
   * @param {(message: string) => void} [debug] Optional debug logger for homey-api.
   */
  constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly timeout: number = 15000,
    private readonly debug?: (message: string) => void,
  ) {
    super();
  }

  /**
   * Homey ID, available after connect()
   *
   * @returns {string | undefined} The Homey ID.
   */
  get homeyId(): string | undefined {
    return this.api?.id;
  }

  /**
   * Connect to the Homey and its realtime device events
   *
   * Emits `disconnected` and `reconnected` when the realtime connection drops and comes back.
   *
   * @returns {Promise<void>} Resolves when connected.
   * @throws {Error} When the Homey can't be reached in time or the API key is rejected.
   */
  async connect(): Promise<void> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the homey-api typings don't describe createLocalAPI and its result
    const { HomeyAPI } = (await import('homey-api')) as unknown as HomeyApiModule;
    const debug = this.debug;
    const api = await withTimeout(
      HomeyAPI.createLocalAPI({
        address: this.address.trim().replace(/\/+$/, ''),
        token: this.token.trim(),
        debug: debug ? (...args: unknown[]): void => debug(args.map(String).join(' ')) : null,
      }),
      this.timeout,
      `Homey not reachable at ${this.address}`,
    );
    this.api = api;
    api.on('disconnect', () => this.emit('disconnected'));
    api.on('reconnect', () => this.emit('reconnected'));
    await withTimeout(api.devices.connect(), this.timeout, 'Timeout connecting to the Homey device events');
    api.devices.on('device.create', (device: HomeyApiDevice) => {
      this.devices.set(device.id, device);
      this.emit('device.create', device);
    });
    api.devices.on('device.update', (device: HomeyApiDevice) => {
      this.devices.set(device.id, device);
      this.emit('device.update', device);
    });
    api.devices.on('device.delete', (device: HomeyApiDevice) => {
      this.devices.delete(device.id);
      this.emit('device.delete', device);
    });
  }

  /**
   * Get all devices
   *
   * @returns {Promise<HomeyDevice[]>} The devices.
   */
  async getDevices(): Promise<HomeyDevice[]> {
    const devices = Object.values(await this.requireApi().devices.getDevices());
    for (const device of devices) this.devices.set(device.id, device);
    return devices;
  }

  /**
   * Get all zones
   *
   * @returns {Promise<HomeyZone[]>} The zones.
   */
  async getZones(): Promise<HomeyZone[]> {
    return Object.values(await this.requireApi().zones.getZones());
  }

  /**
   * Set a capability value of a device
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID, e.g. onoff.
   * @param {HomeyCapabilityValue} value The new value.
   * @returns {Promise<void>} Resolves when Homey accepted the value.
   * @throws {Error} When the device is unknown or Homey rejects the value.
   */
  async setCapabilityValue(deviceId: string, capabilityId: string, value: HomeyCapabilityValue): Promise<void> {
    const instance = this.capabilityInstances.get(`${deviceId}/${capabilityId}`);
    if (instance) await instance.setValue(value);
    else await this.requireDevice(deviceId).setCapabilityValue({ capabilityId, value });
  }

  /**
   * Listen to realtime value changes of a capability
   *
   * Only one listener per device capability is supported: a new subscription replaces the previous one.
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID, e.g. measure_temperature.
   * @param {CapabilityListener} listener Called with the new value.
   * @returns {() => void} A function that stops listening.
   * @throws {Error} When the device is unknown.
   */
  subscribeCapability(deviceId: string, capabilityId: string, listener: CapabilityListener): () => void {
    const key = `${deviceId}/${capabilityId}`;
    this.capabilityInstances.get(key)?.destroy();
    const instance = this.requireDevice(deviceId).makeCapabilityInstance(capabilityId, (value) => listener(value));
    this.capabilityInstances.set(key, instance);
    return () => {
      instance.destroy();
      if (this.capabilityInstances.get(key) === instance) this.capabilityInstances.delete(key);
    };
  }

  /**
   * Close the connection and stop all capability listeners
   *
   * @returns {Promise<void>} Resolves when closed.
   */
  async close(): Promise<void> {
    for (const instance of this.capabilityInstances.values()) instance.destroy();
    this.capabilityInstances.clear();
    this.devices.clear();
    const api = this.api;
    this.api = undefined;
    if (!api) return;
    api.removeAllListeners();
    api.devices.removeAllListeners();
    try {
      await api.devices.disconnect();
    } catch {
      // The socket may already be closed
    }
    api.destroy();
  }

  private requireApi(): HomeyApi {
    if (!this.api) throw new Error('Not connected to Homey');
    return this.api;
  }

  private requireDevice(deviceId: string): HomeyApiDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Homey device ${deviceId} not found`);
    return device;
  }
}

/**
 * Reject a promise when it doesn't settle in time
 *
 * @param {Promise<T>} promise The promise to wait for.
 * @param {number} timeout The timeout in milliseconds.
 * @param {string} message The error message on timeout.
 * @returns {Promise<T>} The result of the promise.
 * @throws {Error} When the timeout expires first.
 */
async function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
