/**
 * matterEnergy.js
 *
 * Publishes the Tesla Wall Connector to Matter controllers as an outlet that
 * reports live electrical measurements, so it appears in the Apple Home Energy
 * view (iOS/tvOS 26+) with live watts on its tile.
 *
 * Background
 * ----------
 * Apple Home's Energy view is driven by *Matter* electrical-measurement
 * clusters, not by classic HomeKit/HAP characteristics. HAP has no native
 * power/energy characteristic, so the Eve custom characteristics this plugin
 * also exposes are only ever read by Eve-class apps and never populate the
 * native Energy tile.
 *
 * Homebridge 2.2.0 added the electrical measurement clusters to its Matter
 * plugin API, and 2.3.0 fixed composition/bridge-online behavior. This module
 * uses that API directly:
 *
 *   grid_v            -> electricalPowerMeasurement.voltage        (mV)
 *   vehicle_current_a -> electricalPowerMeasurement.activeCurrent  (mA)
 *   grid_v * current  -> electricalPowerMeasurement.activePower    (mW)
 *   session_energy_wh -> electricalEnergyMeasurement
 *                          .cumulativeEnergyImported.energy        (mWh)
 *
 * Matter expresses all of these in milli-units, hence the x1000 conversions.
 *
 * Homebridge fills in the mandatory cluster attributes (powerMode,
 * numberOfMeasurementTypes, accuracy) itself, and chooses the feature-gated
 * ElectricalEnergyMeasurement features from which energy attributes we declare
 * (declaring `cumulativeEnergyImported` selects ImportedEnergy + CumulativeEnergy).
 * So this module only declares the readings themselves.
 *
 * Requirements
 * ------------
 * - Homebridge 2.3.0 or later
 * - Matter enabled on this plugin's child bridge (Homebridge UI ->
 *   plugin settings -> Bridge Settings -> enable Matter)
 *
 * Everything here is feature-detected and guarded: on a Homebridge build
 * without the Matter API, or with Matter disabled, `isSupported()` returns
 * false and the plugin runs HAP/Eve-only exactly as before.
 */

'use strict';

const PLUGIN_NAME = 'homebridge-tesla-wall-connector';
const PLATFORM_NAME = 'TeslaWallConnector';

/** Matter uses milli-units for electrical measurements. */
const milli = (value) => Math.round((Number(value) || 0) * 1000);

class MatterEnergyBridge {
  /**
   * @param {object} platform - the Homebridge platform (provides .api and .log)
   */
  constructor(platform) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;

    this.uuid = null;        // UUID of the registered Matter accessory
    this.registered = false; // true once registration resolved successfully
    this._warnedUpdate = false;
  }

  /**
   * Whether this Homebridge build exposes everything needed to publish an
   * outlet with electrical measurements. Logs at debug level so unsupported
   * builds stay quiet.
   */
  isSupported() {
    const matter = this.api && this.api.matter;
    if (!matter) {
      this.log.debug('[matter] api.matter unavailable — Matter energy export disabled. Requires Homebridge 2.3.0+ with Matter enabled on this plugin\'s child bridge.');
      return false;
    }
    if (!matter.deviceTypes || !matter.deviceTypes.OnOffOutlet) {
      this.log.debug('[matter] api.matter.deviceTypes.OnOffOutlet unavailable — Matter energy export disabled.');
      return false;
    }
    if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
      this.log.debug('[matter] Matter registration/update API unavailable — Matter energy export disabled.');
      return false;
    }
    return true;
  }

  /**
   * Build the Matter cluster state from the plugin's normalized readings.
   * Homebridge adds the mandatory attributes it can derive itself.
   *
   * @param {object} r - readings from TeslaWallConnectorAccessory#getReadings()
   */
  buildClusters(r) {
    return {
      onOff: {
        onOff: !!r.charging,
      },
      electricalPowerMeasurement: {
        voltage: milli(r.voltageV),
        activeCurrent: milli(r.currentA),
        activePower: milli(r.powerW),
      },
      electricalEnergyMeasurement: {
        // A wall charger only ever imports energy from the grid.
        cumulativeEnergyImported: {
          energy: milli(r.energyWh),
        },
      },
    };
  }

  /**
   * Register the charger as a Matter outlet with electrical measurements.
   *
   * @param {string} ip - charger IP, used for the serial number / UUID seed
   * @param {string} displayName
   * @param {object} readings - initial readings to seed the clusters with
   * @returns {Promise<boolean>} whether registration succeeded
   */
  async register(ip, displayName, readings) {
    if (!this.isSupported()) return false;

    const matter = this.api.matter;
    // Distinct from the HAP accessory UUID so the two never collide.
    this.uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:matter:${ip}`);

    const accessory = {
      UUID: this.uuid,
      displayName,
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: ip,
      manufacturer: 'Tesla',
      model: 'Wall Connector Gen 3',
      context: { ip },
      clusters: this.buildClusters(readings),
      handlers: {
        // The Gen 3 local API is read-only: it reports status but cannot start
        // or stop charging. Accept the command so the controller isn't left
        // hanging, warn, and push the true state back so the tile re-syncs.
        onOff: {
          on: async () => this._rejectControl(true),
          off: async () => this._rejectControl(false),
        },
      },
    };

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registered = true;
      this.log.info('[matter] Published Tesla Wall Connector as a Matter outlet with electrical measurements — live power should appear on its tile in the Apple Home Energy view.');
      return true;
    } catch (err) {
      this.log.warn(`[matter] Failed to register Matter accessory (${err && err.message ? err.message : err}). Continuing with HAP/Eve only.`);
      this.registered = false;
      return false;
    }
  }

  /**
   * Called when a controller tries to switch the outlet. Charging cannot be
   * controlled through the local API, so log once per attempt and let the next
   * poll restore the real state.
   */
  _rejectControl(requested) {
    this.log.warn(`[matter] Ignoring request to turn the charger ${requested ? 'on' : 'off'} — the Wall Connector's local API is read-only and cannot control charging.`);
  }

  /**
   * Push fresh readings to the registered Matter accessory.
   * No-op until registration has succeeded.
   *
   * @param {object} readings - readings from getReadings()
   */
  async update(readings) {
    if (!this.registered || !this.uuid) return;

    const matter = this.api.matter;
    const clusters = this.buildClusters(readings);

    try {
      await Promise.all([
        matter.updateAccessoryState(this.uuid, 'onOff', clusters.onOff),
        matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement),
        matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', clusters.electricalEnergyMeasurement),
      ]);
    } catch (err) {
      // Log the first failure at warn, the rest at debug, so a persistently
      // unhappy Matter server can't flood the log on every poll.
      const message = `[matter] Failed to update Matter state: ${err && err.message ? err.message : err}`;
      if (!this._warnedUpdate) {
        this._warnedUpdate = true;
        this.log.warn(message);
      } else {
        this.log.debug(message);
      }
    }
  }
}

module.exports = { MatterEnergyBridge, PLUGIN_NAME, PLATFORM_NAME };
