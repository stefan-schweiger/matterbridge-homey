/**
 * @file vitest/fakeHomey.ts
 * @description A fake Homey connection and device fixtures for the tests.
 * @author Stefan Schweiger
 */

/* oxlint-disable typescript/require-await -- the fake answers immediately but implements the async interface */

import { EventEmitter } from 'node:events';

import type { CapabilityListener, HomeyCapability, HomeyCapabilityValue, HomeyConnection, HomeyDevice, HomeyZone } from '../src/homey.js';

/**
 * A Homey connection that keeps devices and zones in memory.
 */
export class FakeHomey extends EventEmitter implements HomeyConnection {
  homeyId: string | undefined;
  devices: HomeyDevice[] = [];
  zones: HomeyZone[] = [];
  readonly capabilityListeners = new Map<string, CapabilityListener>();
  readonly connect = vi.fn(async (): Promise<void> => {
    this.homeyId = 'homey-id';
  });
  readonly setCapabilityValue = vi.fn(async (deviceId: string, capabilityId: string, value: HomeyCapabilityValue): Promise<void> => {
    this.emit('set', deviceId, capabilityId, value);
  });
  readonly close = vi.fn(async (): Promise<void> => {
    this.homeyId = undefined;
  });

  /**
   * Get all devices
   *
   * @returns {Promise<HomeyDevice[]>} The devices.
   */
  async getDevices(): Promise<HomeyDevice[]> {
    return this.devices;
  }

  /**
   * Get all zones
   *
   * @returns {Promise<HomeyZone[]>} The zones.
   */
  async getZones(): Promise<HomeyZone[]> {
    return this.zones;
  }

  /**
   * Listen to a capability
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID.
   * @param {CapabilityListener} listener The listener.
   * @returns {() => void} Stops listening.
   */
  subscribeCapability(deviceId: string, capabilityId: string, listener: CapabilityListener): () => void {
    const key = `${deviceId}/${capabilityId}`;
    this.capabilityListeners.set(key, listener);
    return () => this.capabilityListeners.delete(key);
  }

  /**
   * Simulate a realtime capability value change reported by Homey
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID.
   * @param {HomeyCapabilityValue} value The new value.
   */
  report(deviceId: string, capabilityId: string, value: HomeyCapabilityValue): void {
    const listener = this.capabilityListeners.get(`${deviceId}/${capabilityId}`);
    if (!listener) throw new Error(`No listener for ${deviceId}/${capabilityId}`);
    listener(value);
  }
}

/**
 * Create a Homey device fixture
 *
 * @param {string} id The device ID.
 * @param {string} name The device name.
 * @param {string} deviceClass The device class.
 * @param {Record<string, HomeyCapabilityValue | Partial<HomeyCapability>>} capabilities The capabilities with their value, or their definition.
 * @param {Partial<HomeyDevice>} [extra] Other device properties.
 * @returns {HomeyDevice} The device.
 */
export function createDevice(
  id: string,
  name: string,
  deviceClass: string,
  capabilities: Record<string, HomeyCapabilityValue | Partial<HomeyCapability>>,
  extra: Partial<HomeyDevice> = {},
): HomeyDevice {
  const capabilitiesObj: Record<string, HomeyCapability> = {};
  for (const [capabilityId, definition] of Object.entries(capabilities)) {
    capabilitiesObj[capabilityId] = definition !== null && typeof definition === 'object' ? { id: capabilityId, ...definition } : { id: capabilityId, value: definition };
  }
  return { id, name, class: deviceClass, zone: 'zone-living', available: true, ready: true, capabilities: Object.keys(capabilities), capabilitiesObj, ...extra };
}

/** Zones: Home > Living room, Home > Kitchen > Pantry. */
export const zones: HomeyZone[] = [
  { id: 'zone-home', name: 'Home', parent: null },
  { id: 'zone-living', name: 'Living room', parent: 'zone-home' },
  { id: 'zone-kitchen', name: 'Kitchen', parent: 'zone-home' },
  { id: 'zone-pantry', name: 'Pantry', parent: 'zone-kitchen' },
];
