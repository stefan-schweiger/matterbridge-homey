# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-18

### Added

- [devices]: Robotic vacuum cleaners with the standard Homey capabilities: start, stop, pause, resume and go home, the state, the clean modes and the battery.

### Changed

- [docs]: The README explains the default color temperature range of lights and installing the plugin from npm.

### Fixed

- [devices]: The Off mode of a thermostat or air conditioner turns `onoff` off instead of setting the `off` mode, which some drivers ignore.
- [platform]: A device that fails to build is skipped with an error instead of stopping the plugin from starting.
- [build]: Test builds of `npm run pack:tarball` are marked private, so Matterbridge reinstalls them from the uploaded tarball when the Docker container is recreated, instead of failing to find a `dev` version on npm.

## [0.1.0] - 2026-10-13

### Added

- [platform]: Connect to a Homey Pro with an API key and expose its devices as Matter bridged devices.
- [platform]: White list, black list and zone filter, with the device picker in the frontend.
- [platform]: Follow device availability, renames, deleted devices and the Homey connection state.
- [platform]: Derive the Matter unique ID from the Homey device ID, so it doesn't change when a device is renamed.
- [devices]: Lights, plugs and outputs, thermostats and air conditioners, window coverings, door locks and fans.
- [platform]: Light and outlet lists to change the device type, capability black lists for all devices and per device, with pickers in the frontend.
- [devices]: The outdoor temperature of thermostats and air conditioners is the outdoorTemperature of the thermostat instead of a separate sensor.
- [build]: `npm run pack:tarball` builds a production tarball to upload in the Matterbridge frontend.
- [devices]: Temperature, humidity, pressure, light, occupancy, contact, water leak, rain, smoke and CO, air quality, electrical and battery sensors.
