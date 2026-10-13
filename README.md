# <img src="https://matterbridge.io/assets/matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;Matterbridge Homey

A [Matterbridge](https://matterbridge.io) plugin that exposes the devices of an Athom **Homey Pro** to Matter, so you can use them in Apple Home, Google Home, Amazon Alexa, SmartThings, Home Assistant and any other Matter controller.

It connects to the local Homey Web API with an **API key**, creates one Matter bridged device per Homey device, and keeps both sides in sync in real time.

## Requirements

- Homey Pro (Early 2023) or Homey Self-Hosted Server with the local Web API. Homey Cloud and Homey Bridge have no local API and no API keys, so they are not supported.
- Matterbridge 3.10.10 or later.
- Node.js 22.13+, 24 or 26 (`homey-api` requires Node.js 22 or later).

## Create an API key

In the Homey web app ([my.homey.app](https://my.homey.app)) open **Settings → API Keys → New API Key** and grant at least:

| Permission      | Why                                        |
| --------------- | ------------------------------------------ |
| View devices    | Read the devices and their values          |
| Control devices | Send the commands from Matter controllers  |
| View zones      | Device names and the zone filter           |
| View System     | Reported to be needed for realtime updates |

The key is shown only once, so copy it right away.

## Configuration

| Setting                     | Description                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`                   | Local address of the Homey, e.g. `http://192.168.1.50`. `https://192-168-1-50.homey.homeylocal.com` also works, unless your router blocks DNS rebinding.    |
| `token`                     | The API key.                                                                                                                                                |
| `whiteList`                 | Only these devices are exposed (names or Homey device IDs). Empty exposes all supported devices. The frontend offers a device picker after the first start. |
| `blackList`                 | These devices are never exposed.                                                                                                                            |
| `zoneWhiteList`             | Only devices in these Homey zones are exposed, including sub-zones. Empty exposes all zones.                                                                |
| `lightList`                 | These devices are exposed as lights, whatever their Homey class.                                                                                            |
| `outletList`                | These devices are exposed as plugs, whatever their Homey class.                                                                                             |
| `capabilityBlackList`       | These Homey capabilities are never exposed, e.g. `meter_power`.                                                                                             |
| `deviceCapabilityBlackList` | Capabilities not exposed for one device: the device name (or ID) and its list of capabilities, e.g. `{ "Multisensor": ["alarm_occupancy"] }`.               |
| `debug`                     | Log the homey-api debug output.                                                                                                                             |
| `unregisterOnShutdown`      | Remove all devices from the controllers on shutdown. For development only.                                                                                  |

## Supported devices

The Matter device type follows the Homey device class (or the class you chose for it in Homey) and its capabilities.

| Homey class                                                         | Capabilities                                                                       | Matter device                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `light`                                                             | `onoff`, `dim`, `light_hue`, `light_saturation`, `light_temperature`, `light_mode` | On/off, dimmable, color temperature or extended color light       |
| `socket` and any other class with `onoff`                           | `onoff`, `dim`, `onoff.*` outputs                                                  | (Dimmable) plug-in unit, one per output                           |
| `thermostat`, `heater`, `heatpump`, `radiator`, `boiler`            | `target_temperature`, `measure_temperature`, `thermostat_mode`, `onoff`            | Thermostat (heating, or heating and cooling with the modes)       |
| `airconditioning`                                                   | `target_temperature`, `measure_temperature`, `thermostat_mode`, `onoff`            | Thermostat (cooling, or all the modes including dry and fan only) |
| `windowcoverings`, `blinds`, `curtain`, `sunshade`, `shutterblinds` | `windowcoverings_set`, `windowcoverings_state`                                     | Window covering (lift)                                            |
| `lock`                                                              | `locked`                                                                           | Door lock                                                         |
| `fan`, `airpurifier`                                                | `onoff`, `fan_speed`                                                               | Fan                                                               |

Sensors are added to any device that has them:

| Capability                                                                         | Matter                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| `measure_temperature`, `measure_humidity`, `measure_pressure`, `measure_luminance` | Temperature, humidity, pressure and light sensor |
| `alarm_motion`, `alarm_occupancy`, `alarm_presence`                                | Occupancy sensor                                 |
| `alarm_contact`, `alarm_water`, `alarm_rain`                                       | Contact sensor, water leak detector, rain sensor |
| `alarm_smoke`, `alarm_co`                                                          | Smoke / CO alarm                                 |
| `measure_co2`, `measure_co`, `measure_pm25`, `measure_pm10`, `measure_tvoc`        | Air quality sensor                               |
| `measure_power`, `meter_power`, `measure_voltage`, `measure_current`               | Electrical power and energy measurement          |
| `measure_battery`, `alarm_battery`                                                 | Battery power source                             |

Sub-capabilities of sensors, e.g. `measure_temperature.inside`, are exposed too. The outdoor temperature of a thermostat or air conditioner (e.g. `measure_temperature.outdoorTemperature`) is part of the thermostat.

### How devices are composed

Each Homey device is one Matter bridged device. Its main function and as many sensors as possible share one endpoint, so controllers show one device instead of one per function (Alexa shows every endpoint as a separate device). A function that can't share the endpoint gets a child endpoint: a second sensor of the same kind (e.g. `alarm_motion` and `alarm_presence`) or a sub-capability (e.g. `onoff.output2`).

The device is reported unreachable when Homey marks it unavailable or when the connection to Homey drops.

### Customizing devices

Like the zigbee2mqtt plugin, the settings can change how a device is exposed:

- **`lightList` / `outletList`**: expose a device as a light or a plug, e.g. a fan switch that Homey classifies as a button. Changing the class of the device in Homey ("What type of device is this?") works too.
- **`capabilityBlackList` / `deviceCapabilityBlackList`**: leave out capabilities, for all devices or for one device. A device whose capabilities are all excluded isn't exposed. A left out capability that had its own endpoint also removes that endpoint, which Alexa would otherwise show as a separate, unnamed device.

The frontend offers the devices and the capabilities they expose in pickers. The lists accept device names, Homey device IDs and serial numbers, like the white and black lists.

### Renaming devices

The Matter identity of a device comes from its Homey device ID, not its name: the endpoint number and the Matter unique ID stay the same when you rename a device in Homey, so controllers keep the device, its room and its automations. The new name is sent to the controllers right away (the node label). Some controllers, Apple Home in particular, keep the name they got when the device was added.

The white and black lists accept Homey device IDs as well as names. Entries by name stop matching when the device is renamed.

### Limitations

- New Homey devices need a Matterbridge restart; the frontend asks for it. Deleted devices are removed right away.
- Devices with the same name get their zone appended, e.g. `Ceiling light Kitchen`.
- Not supported yet: buttons and remotes, media players and TVs (only their `onoff`), vacuum cleaners, window covering tilt, plant moisture, `level_aqi`.

## Install

The plugin isn't published on npm yet. Build a tarball and upload it to Matterbridge:

```bash
npm install
npm link matterbridge
npm run pack:tarball
```

This creates `matterbridge-homey-<version>-dev-<date>-<time>.tgz` in the project folder (`npm run pack:tarball -- --release` keeps the plain version). On the Home page of the Matterbridge frontend, click **Upload** in the **Install plugins** panel and choose the tarball (the panel is hidden when Matterbridge runs read-only). Matterbridge installs it with `npm install -g <tarball> --omit=dev`, so the host needs access to the npm registry for `homey-api`. Then set the address and API key in the plugin configuration and restart.

Uploading a newer tarball replaces the installed version.

## Development

The plugin follows the [Matterbridge plugin template](https://github.com/Luligu/matterbridge-plugin-template). Matterbridge must never be a dependency of the plugin: link a global or locally built Matterbridge with `npm link matterbridge` (see the [development guide](https://matterbridge.io/README-DEV.html)).

| Script                  | Purpose                         |
| ----------------------- | ------------------------------- |
| `npm run build`         | Compile to `dist`               |
| `npm run typecheck`     | Type-check sources and tests    |
| `npm run lint`          | oxlint                          |
| `npm run format`        | oxfmt                           |
| `npm run test`          | Vitest                          |
| `npm run test:coverage` | Vitest with coverage thresholds |

Source layout:

- `src/module.ts`: the Matterbridge dynamic platform (configuration, discovery, filters, lifecycle).
- `src/homey.ts`: the connection to Homey, a thin wrapper around [`homey-api`](https://www.npmjs.com/package/homey-api).
- `src/features.ts`: the mapping of Homey classes and capabilities to Matter device types, clusters and commands.
- `src/homeyDevice.ts`: builds the Matter endpoint of a Homey device and syncs the values in both directions.
- `src/converters.ts`: value conversions (dim ↔ level, hue, mireds, positions, units).

The tests run the platform against a Matter server node with a fake Homey. `vitest/homey.real.test.ts` runs it against your own Homey, read-only (every write is refused): put `HOMEY_ADDRESS`, `HOMEY_TOKEN` and `HOMEY_REAL_TEST=1` in `.env` (ignored by git) and run `npm run test -- vitest/homey.real.test.ts`.

## License

Apache-2.0
