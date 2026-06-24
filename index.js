/**
 * homebridge-tesla-wall-connector
 * Simple Homebridge platform plugin for a Tesla Wall Connector (Gen 3).
 *
 * Exposes:
 *  - Outlet service (On = contactor closed)
 *  - OutletInUse (vehicle connected)
 *  - Eve-friendly custom characteristics for Voltage, Current, Consumption (W) and Total Consumption (kWh)
 *  - (Optional, forward-compatible) a Matter EnergyEvse device so the charger
 *    can appear in the Apple Home Energy view once Homebridge exposes the
 *    Matter energy device types. See matterEnergy.js and:
 *      https://github.com/homebridge/homebridge/issues/3942
 *
 * Configuration (in Homebridge `config.json` platforms array):
 * {
 *   "platform": "TeslaWallConnector",
 *   "name": "Tesla Wall Connector",
 *   "ipAddress": "192.168.1.50",
 *   "pollInterval": 30000,
 *   "matter": false
 * }
 *
 * `matter` (default false): opt in to publishing the charger as a Matter
 * EnergyEvse device. This is a safe no-op on every current Homebridge build —
 * it only takes effect once the platform surfaces the Matter energy API — so it
 * can be turned on ahead of time with no risk.
 *
 * Notes:
 * - This plugin polls the wall connector's /api/1/vitals endpoint.
 * - Compatible with Homebridge 1.8+ and Homebridge 2.0 (HAP-NodeJS v1).
 */

const axios = require('axios');
const { MatterEnergyBridge } = require('./matterEnergy');

let Service, Characteristic, hap;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  hap = homebridge.hap;

  homebridge.registerPlatform('homebridge-tesla-wall-connector', 'TeslaWallConnector', TeslaWallConnectorPlatform, true);
};

class TeslaWallConnectorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    this.log.debug('TeslaWallConnector platform initialized with config:', this.config);

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }
  }

  configureAccessory(accessory) {
    this.log.info('Restoring accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    if (!this.config.ipAddress) {
      this.log.error('No IP Address configured for Tesla Wall Connector');
      return;
    }

    const uuid = hap.uuid.generate(this.config.ipAddress);
    const existing = this.accessories.find(a => a.UUID === uuid);

    if (existing) {
      this.log.info('Restoring existing accessory:', existing.displayName);
      new TeslaWallConnectorAccessory(this, existing);
    } else {
      this.log.info('Adding new accessory for', this.config.name || this.config.ipAddress);
      const accessory = new this.api.platformAccessory(this.config.name || 'Tesla Wall Connector', uuid);
      accessory.context.device = { ip: this.config.ipAddress };
      new TeslaWallConnectorAccessory(this, accessory);
      this.api.registerPlatformAccessories('homebridge-tesla-wall-connector', 'TeslaWallConnector', [accessory]);
    }
  }
}

const CustomUUIDs = {
  Voltage: 'E863F10A-079E-48FF-8F27-9C2605A29F52',
  Current: 'E863F126-079E-48FF-8F27-9C2605A29F52',
  Consumption: 'E863F10D-079E-48FF-8F27-9C2605A29F52',
  TotalConsumption: 'E863F10C-079E-48FF-8F27-9C2605A29F52',
};

class TeslaWallConnectorAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;

    // internal state
    this.state = {
      contactorClosed: false,
      vehicleConnected: false,
      voltage: 0,
      current: 0,
      powerWatts: 0,
      totalWh: 0
    };

    // Information
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Tesla')
      .setCharacteristic(Characteristic.Model, 'Wall Connector Gen 3')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.device && accessory.context.device.ip ? accessory.context.device.ip : 'unknown');

    // Main Outlet Service
    this.service = this.accessory.getService(Service.Outlet) || this.accessory.addService(Service.Outlet, accessory.displayName);

    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    // Create custom characteristics and keep references
    this.customChars = {};
    this.setupCustomCharacteristics();

    // Initial values
    this.service.updateCharacteristic(Characteristic.On, false);
    this.service.updateCharacteristic(Characteristic.OutletInUse, false);

    // Matter-readiness shim (opt-in via config `matter: true`).
    // No-op on current Homebridge builds; lights up automatically once the
    // platform exposes the Matter energy device types (homebridge#3942).
    this.matter = null;
    if (this.platform.config.matter) {
      this.matter = new MatterEnergyBridge(this.platform);
      if (this.matter.detect()) {
        this.matter.register(this.accessory, this.getReadings());
      } else {
        this.log.info('[matter] Config option "matter" is enabled but this Homebridge build does not yet expose the Matter energy device types — the charger will appear in the Apple Home Energy view once it does (homebridge#3942). No action needed.');
      }
    }

    // Start polling
    this.pollStatus();
    const interval = this.platform.config.pollInterval || 30000;
    this._pollTimer = setInterval(() => this.pollStatus(), interval);
  }

  setupCustomCharacteristics() {
    // Helper to create and add a custom characteristic (Eve-compatible)
    // Uses the HAP-NodeJS v1 (Homebridge 2.0) compatible class-extension pattern.
    const addCustom = (uuid, key, props) => {
      const CharClass = class extends hap.Characteristic {
        static UUID = uuid;
        constructor() {
          super(props.displayName || key, uuid, {
            format: props.format || hap.Formats.FLOAT,
            unit: props.unit || undefined,
            perms: props.perms || [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
      };

      // Add to service if not already present
      let existing = this.service.getCharacteristic(CharClass);
      if (!existing) {
        try {
          existing = this.service.addCharacteristic(CharClass);
        } catch (err) {
          this.log.warn('Could not add custom characteristic', uuid, err.message || err);
          return;
        }
      }

      this.customChars[key] = existing;
    };

    addCustom(CustomUUIDs.Voltage, 'voltage', { displayName: 'Voltage', unit: 'V' });
    addCustom(CustomUUIDs.Current, 'current', { displayName: 'Current', unit: 'A' });
    addCustom(CustomUUIDs.Consumption, 'consumption', { displayName: 'Consumption', unit: 'W' });
    addCustom(CustomUUIDs.TotalConsumption, 'totalConsumption', { displayName: 'Total Consumption', unit: 'kWh' });
  }

  async pollStatus() {
    const ip = this.accessory.context.device.ip;
    const url = `http://${ip}/api/1/vitals`;
    try {
      const res = await axios.get(url, { timeout: 5000 });
      const data = res.data;

      const contactorClosed = !!data.contactor_closed;
      const vehicleConnected = !!data.vehicle_connected;
      const voltage = Number(data.grid_v || 0);
      const current = Number(data.vehicle_current_a || 0);
      const power = Math.round(voltage * current);
      const sessionWh = Number(data.session_energy_wh || 0);

      const changed = (
        contactorClosed !== this.state.contactorClosed ||
        vehicleConnected !== this.state.vehicleConnected ||
        voltage !== this.state.voltage ||
        current !== this.state.current ||
        power !== this.state.powerWatts ||
        sessionWh !== this.state.totalWh
      );

      this.state = { contactorClosed, vehicleConnected, voltage, current, powerWatts: power, totalWh: sessionWh };

      if (changed) {
        this.updateCharacteristics();
      }
    } catch (error) {
      this.log.error(`Failed to poll ${url}: ${error && error.message ? error.message : error}`);
    }
  }

  /**
   * Normalized electrical readings, in human units. This is the single source
   * of truth consumed by both the Eve characteristic update path and the Matter
   * EnergyEvse bridge, so the two stay in sync and the Matter cluster mapping
   * lives in exactly one place (matterEnergy.js#buildClusters).
   */
  getReadings() {
    return {
      voltageV: this.state.voltage,
      currentA: this.state.current,
      powerW: this.state.powerWatts,
      energyWh: this.state.totalWh,
      vehicleConnected: this.state.vehicleConnected,
      charging: this.state.contactorClosed,
    };
  }

  updateCharacteristics() {
    // Outlet "On" = contactor closed (charging)
    try {
      this.service.updateCharacteristic(Characteristic.On, this.state.contactorClosed);
      this.service.updateCharacteristic(Characteristic.OutletInUse, this.state.vehicleConnected);
    } catch (e) {
      this.log.warn('Failed to update outlet characteristics:', e.message || e);
    }

    // Update custom Eve characteristics if created
    try {
      if (this.customChars.voltage) this.customChars.voltage.updateValue(this.state.voltage);
      if (this.customChars.current) this.customChars.current.updateValue(this.state.current);
      if (this.customChars.consumption) this.customChars.consumption.updateValue(this.state.powerWatts);
      if (this.customChars.totalConsumption) this.customChars.totalConsumption.updateValue(this.state.totalWh / 1000); // kWh
    } catch (e) {
      this.log.warn('Failed to update custom characteristics:', e.message || e);
    }

    // Push the same readings to the Matter EnergyEvse device (no-op unless active)
    if (this.matter) this.matter.update(this.getReadings());
  }

  // Homebridge will call this on shutdown/unload
  remove() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }
}
