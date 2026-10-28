/**
 * @file vitest/homey.real.test.ts
 * @description Read-only test of the platform against a real Homey. Runs only when HOMEY_REAL_TEST=1, HOMEY_ADDRESS and HOMEY_TOKEN are set (environment or .env).
 * @author Stefan Schweiger
 */

const NAME = 'HomeyReal';
const MATTER_PORT = 6400;
const REALTIME_WAIT = Number(process.env.HOMEY_REALTIME_WAIT ?? 30000);

import { existsSync, readFileSync } from 'node:fs';

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
import { log, loggerErrorSpy, setupTest } from 'matterbridge/test-utils/vitest/setup';

import { type CapabilityListener, HomeyApiConnection, type HomeyCapabilityValue } from '../src/homey.js';
import { HomeyPlatform } from '../src/module.js';

const env: Record<string, string | undefined> = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const [key, ...value] = line.split('=');
    if (key.trim() && env[key.trim()] === undefined) env[key.trim()] = value.join('=').trim();
  }
}
const address = env.HOMEY_ADDRESS;
const token = env.HOMEY_TOKEN;

/**
 * A Homey connection that never changes anything on the Homey.
 */
class ReadOnlyHomeyConnection extends HomeyApiConnection {
  readonly writes: string[] = [];
  readonly events = new Map<string, number>();

  /**
   * Refuse to set a capability value
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID.
   * @param {HomeyCapabilityValue} value The value.
   * @returns {Promise<void>} Always rejects.
   */
  override async setCapabilityValue(deviceId: string, capabilityId: string, value: HomeyCapabilityValue): Promise<void> {
    this.writes.push(`${deviceId}/${capabilityId}=${String(value)}`);
    throw new Error('Read-only test: writes are disabled');
  }

  /**
   * Listen to a capability and count its events
   *
   * @param {string} deviceId The device ID.
   * @param {string} capabilityId The capability ID.
   * @param {CapabilityListener} listener The listener.
   * @returns {() => void} Stops listening.
   */
  override subscribeCapability(deviceId: string, capabilityId: string, listener: CapabilityListener): () => void {
    return super.subscribeCapability(deviceId, capabilityId, (value) => {
      this.events.set(capabilityId, (this.events.get(capabilityId) ?? 0) + 1);
      listener(value);
    });
  }
}

await setupTest(NAME, false);

describe.skipIf(env.HOMEY_REAL_TEST !== '1' || !address || !token)('HomeyPlatform with a real Homey (read-only)', () => {
  const homey = new ReadOnlyHomeyConnection(address ?? '', token ?? '');
  let platform: HomeyPlatform;

  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(MATTER_PORT);
  });

  afterAll(async () => {
    await flushServerNode();
    await destroyTestEnvironment();
    vi.restoreAllMocks();
  });

  test('should register, configure and follow the devices of the Homey', { timeout: REALTIME_WAIT + 120000 }, async () => {
    platform = new HomeyPlatform(
      getMatterbridge(),
      log,
      {
        name: 'matterbridge-homey',
        type: 'DynamicPlatform',
        version: '1.0.0',
        address: address ?? '',
        token: token ?? '',
        whiteList: [],
        blackList: [],
        zoneWhiteList: [],
        lightList: [],
        outletList: [],
        capabilityBlackList: [],
        deviceCapabilityBlackList: {},
        newDevices: 'default',
        debug: false,
        unregisterOnShutdown: false,
      },
      homey,
    );
    // @ts-expect-error - setMatterNode is intentionally private
    platform.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, addVirtualEndpoint);

    const started = Date.now();
    await platform.onStart('Real test');
    await platform.onConfigure();
    // The test setup silences the console, so the report goes to stdout directly.
    const report = (line: string): boolean => process.stdout.write(`${line}\n`);
    const errors = loggerErrorSpy.mock.calls.map((call) => call[0]);
    report(`Registered ${platform.bridgedDevices.size} devices in ${Date.now() - started} ms with ${errors.length} errors`);
    for (const error of errors) report(`  error: ${error}`);
    expect(platform.bridgedDevices.size).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, REALTIME_WAIT));
    report(`Realtime events in ${REALTIME_WAIT / 1000}s: ${JSON.stringify(Object.fromEntries(homey.events))}`);
    const realtimeErrors = loggerErrorSpy.mock.calls.map((call) => call[0]).slice(errors.length);
    for (const error of realtimeErrors) report(`  realtime error: ${error}`);
    expect(realtimeErrors).toEqual([]);
    expect(homey.writes).toEqual([]);

    await platform.onShutdown('Real test');
  });
});
