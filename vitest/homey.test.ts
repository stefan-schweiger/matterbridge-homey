/**
 * @file vitest/homey.test.ts
 * @description Tests of the homey-api wrapper.
 * @author Stefan Schweiger
 */

import { HomeyApiConnection } from '../src/homey.js';

const { createLocalAPI, api, device, instance } = await vi.hoisted(async () => {
  // vi.hoisted runs before the static imports
  const { EventEmitter: Emitter } = await import('node:events');
  const instance = { setValue: vi.fn(async () => {}), destroy: vi.fn() };
  const device = {
    id: 'device-1',
    name: 'Lamp',
    class: 'light',
    capabilities: ['onoff'],
    makeCapabilityInstance: vi.fn((_capabilityId: string, _listener: (value: unknown) => void) => instance),
    setCapabilityValue: vi.fn(async () => {}),
  };
  const devices = Object.assign(new Emitter(), {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getDevices: vi.fn(async () => ({ [device.id]: device })),
  });
  const zones = Object.assign(new Emitter(), { getZones: vi.fn(async () => ({ z1: { id: 'z1', name: 'Kitchen', parent: null } })) });
  const api = Object.assign(new Emitter(), { id: 'homey-1', devices, zones, destroy: vi.fn() });
  const createLocalAPI = vi.fn(async (_opts: { address: string; token: string }) => api);
  return { createLocalAPI, api, device, instance };
});

vi.mock('homey-api', () => ({ HomeyAPI: { createLocalAPI } }));

describe('HomeyApiConnection', () => {
  test('should connect with the trimmed address and API key', async () => {
    const connection = new HomeyApiConnection('http://192.168.1.50/ ', ' api-key ');
    expect(connection.homeyId).toBeUndefined();
    await connection.connect();
    expect(createLocalAPI).toHaveBeenCalledWith(expect.objectContaining({ address: 'http://192.168.1.50', token: 'api-key', debug: null }));
    expect(api.devices.connect).toHaveBeenCalled();
    expect(connection.homeyId).toBe('homey-1');
    expect(await connection.getZones()).toEqual([{ id: 'z1', name: 'Kitchen', parent: null }]);
    expect((await connection.getDevices()).map((homeyDevice) => homeyDevice.id)).toEqual(['device-1']);

    // Values are written through the capability instance once subscribed, so Homey doesn't echo them.
    await connection.setCapabilityValue('device-1', 'onoff', true);
    expect(device.setCapabilityValue).toHaveBeenCalledWith({ capabilityId: 'onoff', value: true });
    const listener = vi.fn();
    const unsubscribe = connection.subscribeCapability('device-1', 'onoff', listener);
    device.makeCapabilityInstance.mock.calls[0][1](false);
    expect(listener).toHaveBeenCalledWith(false);
    await connection.setCapabilityValue('device-1', 'onoff', false);
    expect(instance.setValue).toHaveBeenCalledWith(false);
    unsubscribe();
    expect(instance.destroy).toHaveBeenCalledTimes(1);

    await expect(connection.setCapabilityValue('unknown', 'onoff', true)).rejects.toThrow('Homey device unknown not found');
    await connection.close();
  });

  test('should forward device and connection events', async () => {
    const connection = new HomeyApiConnection('http://homey', 'api-key', 1000, vi.fn());
    await connection.connect();
    const events: string[] = [];
    for (const event of ['device.create', 'device.update', 'device.delete', 'disconnected', 'reconnected']) connection.on(event, () => events.push(event));
    api.devices.emit('device.create', { ...device, id: 'device-2' });
    api.devices.emit('device.update', device);
    api.devices.emit('device.delete', { id: 'device-2' });
    api.emit('disconnect');
    api.emit('reconnect');
    expect(events).toEqual(['device.create', 'device.update', 'device.delete', 'disconnected', 'reconnected']);

    connection.subscribeCapability('device-1', 'onoff', vi.fn());
    await connection.close();
    expect(instance.destroy).toHaveBeenCalled();
    expect(api.devices.disconnect).toHaveBeenCalled();
    expect(api.destroy).toHaveBeenCalled();
    await expect(connection.getDevices()).rejects.toThrow('Not connected to Homey');
    await connection.close();
  });

  test("should time out when the Homey doesn't answer", async () => {
    createLocalAPI.mockImplementationOnce(async () => new Promise<typeof api>(() => {}));
    const connection = new HomeyApiConnection('http://10.0.0.1', 'api-key', 50);
    await expect(connection.connect()).rejects.toThrow('Homey not reachable at http://10.0.0.1');
  });
});
