/**
 * homebridge-tesla-wall-connector
 * Simple Homebridge platform plugin for a Tesla Wall Connector (Gen 3).
 *
 * Exposes:
 *  - Outlet service (On = contactor closed)
 *  - OutletInUse (vehicle connected)
 *  - Eve-friendly custom characteristics for Voltage, Current, Consumption (W) and Total Consumption (kWh)
 *
 * Configuration (in Homebridge `config.json` platforms array):
 * {
 *   "platform": "TeslaWallConnector",
 *   "name": "Tesla Wall Connector",
 *   "ipAddress": "192.168.1.50",
 *   "pollInterval": 30000
 * }
 *
 * Notes:
 * - This plugin polls the wall connector's /api/1/vitals endpoint.
 * - Tested on Node 14+ and Homebridge 1.3+.
 */

const axios = require('axios');

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

    // Start polling
    this.pollStatus();
    const interval = this.platform.config.pollInterval || 30000;
    this._pollTimer = setInterval(() => this.pollStatus(), interval);
  }

  setupCustomCharacteristics() {
    // Helper to create and add a custom characteristic (Eve)
    const addCustom = (uuid, key, props) => {
      // create a new Characteristic class instance using HAP constructor form
      // Note: creating dynamic characteristics is somewhat advanced; HomeKit clients may or may not display them.
      const CharClass = function() {
        hap.Characteristic.call(this, props.displayName || key, uuid);
        Object.assign(this.props, {
          format: props.format || Characteristic.Formats.FLOAT,
          unit: props.unit || null,
          perms: props.perms || [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
      };
      CharClass.UUID = uuid;
      CharClass.prototype = Object.create(hap.Characteristic.prototype);
      CharClass.prototype.constructor = CharClass;

      // Register (locally) if not already (avoid duplicate registration errors)
      try {
        hap.Characteristic[uuid] = hap.Characteristic[uuid] || CharClass;
      } catch (e) {
        // ignore
      }

      // Add to service if not present
      let existing = this.service.getCharacteristic(CharClass);
      if (!existing) {
        try {
          existing = this.service.addCharacteristic(CharClass);
        } catch (e) {
          // In some versions, addCharacteristic expects Characteristic class, in others an instance — handle both
          try {
            existing = this.service.addCharacteristic(new CharClass());
          } catch (err) {
            this.log.warn('Could not add custom characteristic', uuid, err.message || err);
            return;
          }
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
  }

  // Homebridge will call this on shutdown/unload
  remove() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }
}

