/**
 * matterEnergy.js
 *
 * Matter-readiness shim for the Tesla Wall Connector plugin.
 *
 * Background
 * ----------
 * Apple Home's native Energy view (iOS 27+) is driven by *Matter* energy
 * device types and their electrical-measurement clusters — NOT by classic
 * HomeKit/HAP characteristics. HAP has no native power/energy characteristic,
 * so the Eve custom characteristics this plugin exposes (Voltage / Current /
 * Consumption / Total Consumption) are only read by Eve-class apps and never
 * populate Apple's native Energy tile.
 *
 * A Tesla Wall Connector maps almost 1:1 onto the Matter `EnergyEvse`
 * (Electric Vehicle Supply Equipment) device type:
 *
 *   grid_v            -> Electrical Power Measurement  : voltage
 *   vehicle_current_a -> Electrical Power Measurement  : activeCurrent
 *   grid_v * current  -> Electrical Power Measurement  : activePower
 *   session_energy_wh -> Electrical Energy Measurement : cumulativeEnergyImported
 *
 * The blocker
 * -----------
 * Homebridge 2.x embeds a Matter server, but its curated `api.matter.deviceTypes`
 * map does not yet surface the energy device types (EnergyEvse, ElectricalMeter,
 * SolarPower, BatteryStorage, ...). Tracked upstream in:
 *   https://github.com/homebridge/homebridge/issues/3942
 *
 * This module is therefore a *forward-compatible shim*. It:
 *   - detects, at runtime, whether the Matter EnergyEvse API is reachable;
 *   - is a guaranteed no-op on every current Homebridge build (the API isn't
 *     there, so detect() returns false and nothing else runs);
 *   - registers + updates a Matter EnergyEvse device automatically once the
 *     platform exposes the API, with no further code changes required.
 *
 * Everything that touches the (not-yet-final) Matter API is wrapped so that a
 * partially-implemented or differently-shaped API can never crash the plugin —
 * worst case it logs and falls back to HAP/Eve only.
 */

'use strict';

const MATTER_ISSUE_URL = 'https://github.com/homebridge/homebridge/issues/3942';

class MatterEnergyBridge {
  /**
   * @param {object} platform - the Homebridge platform (provides .api and .log)
   */
  constructor(platform) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;

    this.deviceType = null; // resolved Matter EnergyEvse device type, when available
    this.node = null;       // handle returned by the registration call, when available
    this.enabled = false;   // true if the API surface was detected
    this.active = false;    // true once a Matter device has actually been registered
  }

  /**
   * Detect whether this Homebridge build exposes the Matter EnergyEvse device type.
   * Returns true only if the device type is reachable through the public API.
   * Logs at debug level so it never spams logs on unsupported builds.
   */
  detect() {
    const deviceTypes = this.api && this.api.matter && this.api.matter.deviceTypes;
    if (!deviceTypes) {
      this.log.debug(`[matter] api.matter.deviceTypes not available on this Homebridge build — Matter energy export disabled. Tracking: ${MATTER_ISSUE_URL}`);
      this.enabled = false;
      return false;
    }

    // Accept either capitalization in case the final API name differs slightly.
    const evse = deviceTypes.EnergyEvse || deviceTypes.energyEvse || null;
    if (!evse) {
      this.log.debug(`[matter] api.matter.deviceTypes present but EnergyEvse not yet exposed — Matter energy export disabled. Tracking: ${MATTER_ISSUE_URL}`);
      this.enabled = false;
      return false;
    }

    this.deviceType = evse;
    this.enabled = true;
    return true;
  }

  /**
   * Translate the plugin's normalized readings into Matter cluster attributes.
   * Matter expresses electrical quantities in milli-units (mV / mA / mW / mWh).
   *
   * Attribute names follow the Matter 1.3/1.4 spec for the Electrical Power
   * Measurement, Electrical Energy Measurement and Energy EVSE clusters. If the
   * final Homebridge binding uses different keys, this is the one place to adjust.
   *
   * @param {object} r - readings from TeslaWallConnectorAccessory#getReadings()
   */
  buildClusters(r) {
    return {
      electricalPowerMeasurement: {
        voltage: Math.round((r.voltageV || 0) * 1000),       // mV
        activeCurrent: Math.round((r.currentA || 0) * 1000), // mA
        activePower: Math.round((r.powerW || 0) * 1000),     // mW
      },
      electricalEnergyMeasurement: {
        // A wall charger only ever *imports* energy from the grid.
        cumulativeEnergyImported: {
          energy: Math.round((r.energyWh || 0) * 1000),      // mWh
        },
      },
      energyEvse: {
        state: r.vehicleConnected
          ? (r.charging ? 'PluggedInCharging' : 'PluggedInDemand')
          : 'NotPluggedIn',
        supplyState: r.charging ? 'ChargingEnabled' : 'Disabled',
      },
    };
  }

  /**
   * Register the accessory as a Matter EnergyEvse device, if the platform
   * exposes a registration entry point. Fully guarded: on any unexpected API
   * shape it logs once and disables itself, leaving HAP/Eve untouched.
   *
   * @param {object} accessory - the Homebridge platformAccessory
   * @param {object} readings - initial readings to seed the device with
   * @returns {boolean} whether a Matter device was successfully registered
   */
  register(accessory, readings) {
    if (!this.enabled) return false;

    try {
      // The exact registration entry point is not finalized upstream (#3942),
      // so probe for the most likely candidates and bail cleanly if none exist.
      // This way the plugin never throws on a build that exposes the device type
      // but not (yet) a way to publish it.
      const publish =
        (this.api.matter && typeof this.api.matter.publishDevice === 'function')
          ? this.api.matter.publishDevice.bind(this.api.matter)
          : (typeof accessory.configureMatterDevice === 'function')
            ? accessory.configureMatterDevice.bind(accessory)
            : null;

      if (!publish) {
        this.log.info(`[matter] EnergyEvse device type is available but no registration entry point was found on this build. Skipping Matter export — please finalize the call site against ${MATTER_ISSUE_URL}.`);
        return false;
      }

      this.node = publish({
        deviceType: this.deviceType,
        clusters: this.buildClusters(readings),
      });
      this.active = true;
      this.log.info('[matter] Registered Tesla Wall Connector as a Matter EnergyEvse device — it will appear in the Apple Home Energy view.');
      return true;
    } catch (err) {
      this.log.warn(`[matter] Failed to register Matter EnergyEvse device (${err && err.message ? err.message : err}). Falling back to HAP/Eve only.`);
      this.active = false;
      return false;
    }
  }

  /**
   * Push fresh readings to the registered Matter device. No-op until a device
   * has actually been registered. Guarded so a mismatched update API can't
   * disrupt the regular HAP/Eve update path.
   *
   * @param {object} readings - readings from getReadings()
   */
  update(readings) {
    if (!this.active || !this.node) return;
    try {
      if (typeof this.node.update === 'function') {
        this.node.update(this.buildClusters(readings));
      }
    } catch (err) {
      this.log.debug(`[matter] update skipped: ${err && err.message ? err.message : err}`);
    }
  }
}

module.exports = { MatterEnergyBridge };
