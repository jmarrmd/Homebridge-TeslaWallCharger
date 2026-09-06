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

/**
 * EnergyEvse cluster enums (Matter spec / @matter/types energy-evse).
 * Inlined so the plugin does not need to import @matter just to read a number.
 */
const EvseState = {
  NotPluggedIn: 0,
  PluggedInNoDemand: 1,
  PluggedInDemand: 2,
  PluggedInCharging: 3,
  PluggedInDischarging: 4,
  SessionEnding: 5,
  Fault: 6,
};

const EvseSupplyState = {
  Disabled: 0,
  ChargingEnabled: 1,
  DischargingEnabled: 2,
  DisabledError: 3,
  DisabledDiagnostics: 4,
};

const EVSE_FAULT_STATE_NO_ERROR = 0;

/**
 * Current limits reported by the EnergyEvse cluster, in mA.
 * A hardwired Gen 3 Wall Connector is commonly on a 60 A circuit at 48 A
 * continuous; 6 A is the J1772 minimum. These are advertised capability
 * figures, not live readings — the live current comes from the electrical
 * measurement clusters.
 */
const EVSE_MIN_CHARGE_CURRENT_MA = 6000;
const EVSE_MAX_CHARGE_CURRENT_MA = 48000;
const EVSE_CIRCUIT_CAPACITY_MA = 48000;

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
    this.mode = null;        // 'evse' or 'outlet', set once registered
    this._warnedUpdate = {}; // per-cluster, so one noisy cluster stays quiet
  }

  /**
   * Try to resolve the Matter EnergyEvse device type.
   *
   * Homebridge's curated `api.matter.deviceTypes` map is a convenience
   * re-export, not a whitelist — `MatterAccessory.deviceType` accepts any
   * matter.js `EndpointType`. EnergyEvse is absent from that map but does ship
   * in `@matter/main`, which Homebridge depends on.
   *
   * It must be loaded as **ESM**, not with require(). @matter ships dual
   * builds:
   *
   *     "import":  "./dist/esm/index.js"    <- Homebridge (type: module) uses this
   *     "require": "./dist/cjs/index.js"    <- a CommonJS require() gets this
   *
   * The two are separate module instances with separate class identities, so a
   * device type built from the CJS copy fails matter.js's behavior check inside
   * Homebridge's ESM copy with `"<uuid>.energyEvse" is not a Behavior.Type`.
   * Loading the ESM file by URL gives the same instance Homebridge validates
   * against, because Node caches ESM modules by resolved URL.
   *
   * The plugin does not declare @matter itself, so this depends on the install
   * layout. Returns null if it cannot be found, and the caller falls back to
   * the outlet device type.
   *
   * @returns {Promise<object|null>} the EnergyEvseDevice endpoint type, or null
   */
  async resolveEvseDeviceType() {
    const path = require('path');
    const { pathToFileURL } = require('url');

    // Anchor on the `devices/*` subpath, which the package does export.
    // (`./package.json` is not exported, so it cannot be resolved.)
    // require.resolve() gives the CJS twin under dist/cjs; the ESM build sits
    // beside it under dist/esm. A bare import() specifier is no use here — it
    // would resolve from this plugin's directory, which cannot see Homebridge's
    // nested node_modules.
    const specifiers = [
      '@matter/node/devices/energy-evse',
      '@matter/main/devices/energy-evse',
    ];

    const roots = this._matterResolutionRoots();
    const tried = [];

    for (const specifier of specifiers) {
      let cjsPath;
      try {
        cjsPath = require.resolve(specifier, { paths: roots });
      } catch (err) {
        tried.push(`${specifier}: ${err && err.code ? err.code : (err && err.message) || err}`);
        continue;
      }

      const sep = path.sep;
      const esmPath = cjsPath.split(`${sep}dist${sep}cjs${sep}`).join(`${sep}dist${sep}esm${sep}`);

      // Prefer the ESM twin; fall back to whatever resolve gave us if this
      // package is not laid out with the dual-build convention.
      for (const file of esmPath === cjsPath ? [cjsPath] : [esmPath, cjsPath]) {
        try {
          const mod = await import(pathToFileURL(file).href);
          const device = this._pickDevice(mod);
          if (device) {
            this.log.debug(`[matter] Resolved EnergyEvse device type from ${file}`);
            return device;
          }
          tried.push(`${file}: loaded but no EnergyEvseDevice export`);
        } catch (err) {
          tried.push(`${file}: ${err && err.code ? err.code : (err && err.message) || err}`);
        }
      }
    }

    this.log.debug(`[matter] EnergyEvse resolution attempts:\n  ${tried.join('\n  ')}`);
    this.log.debug(`[matter] Searched roots:\n  ${roots.join('\n  ')}`);
    return null;
  }

  /** Extract the device type export from a loaded matter.js devices module. */
  _pickDevice(mod) {
    if (!mod) return null;
    return mod.EnergyEvseDevice || (mod.default && mod.default.EnergyEvseDevice) || null;
  }

  /**
   * Candidate `node_modules` roots to resolve @matter from.
   *
   * Homebridge is ESM, so `require.main` is not available to a CommonJS plugin.
   * The reliable anchor is the running Homebridge entry script: walking up from
   * it yields `<homebridge-install>/node_modules`, where its dependencies live.
   */
  _matterResolutionRoots() {
    const path = require('path');
    const roots = [];

    const addAncestors = (startDir) => {
      let dir = startDir;
      for (;;) {
        if (path.basename(dir) !== 'node_modules') {
          const candidate = path.join(dir, 'node_modules');
          if (!roots.includes(candidate)) roots.push(candidate);
        } else if (!roots.includes(dir)) {
          roots.push(dir);
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    };

    try {
      if (process.argv && process.argv[1]) addAncestors(path.dirname(process.argv[1]));
    } catch (e) { /* ignore */ }

    for (const p of module.paths || []) {
      if (!roots.includes(p)) roots.push(p);
    }

    return roots;
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
  buildClusters(r, { includeOnOff = true } = {}) {
    return {
      ...(includeOnOff ? { onOff: { onOff: !!r.charging } } : {}),
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
   * Map the charger's state onto the EnergyEvse cluster.
   *
   * The electrical measurement clusters are declared alongside: the EnergyEvse
   * device type does not include them in its own behaviors, but Homebridge
   * attaches them from the declared cluster state regardless of device type.
   *
   * @param {object} r - readings from getReadings()
   */
  /** Map the charger's state onto the EnergyEvse cluster's state attributes. */
  evseState(r) {
    let state = EvseState.NotPluggedIn;
    if (r.vehicleConnected) {
      state = r.charging ? EvseState.PluggedInCharging : EvseState.PluggedInNoDemand;
    }
    return {
      state,
      supplyState: r.charging ? EvseSupplyState.ChargingEnabled : EvseSupplyState.Disabled,
    };
  }

  /**
   * Seed the EnergyEvse device type with its initial cluster state.
   *
   * This deliberately does NOT go through `MatterAccessory.clusters`. Homebridge
   * turns each declared cluster name into a matter.js Behavior via its own
   * name->behavior map, which only knows the clusters it curates; passing
   * `energyEvse` there fails endpoint construction with
   * `"…energyEvse" is not a Behavior.Type`.
   *
   * The EnergyEvse device type already carries the EnergyEvse and
   * EnergyEvseMode behaviors as mandatory requirements, so the state is applied
   * with matter.js's own `MutableEndpoint.set()` instead.
   *
   * @param {object} deviceType - EnergyEvseDevice
   * @param {object} r - initial readings
   * @returns {object} the device type with defaults applied (or unchanged on failure)
   */
  composeEvseDeviceType(deviceType, r) {
    if (typeof deviceType.set !== 'function') {
      this.log.debug('[matter] EnergyEvse device type has no set(); using matter.js defaults.');
      return deviceType;
    }

    try {
      return deviceType.set({
        energyEvse: {
          ...this.evseState(r),
          faultState: EVSE_FAULT_STATE_NO_ERROR,
          chargingEnabledUntil: null,
          sessionId: null,
          circuitCapacity: EVSE_CIRCUIT_CAPACITY_MA,
          minimumChargeCurrent: EVSE_MIN_CHARGE_CURRENT_MA,
          maximumChargeCurrent: EVSE_MAX_CHARGE_CURRENT_MA,
        },
        // EnergyEvseMode is mandatory on this device type. The charger exposes
        // no selectable modes over the local API, so a single mode is
        // advertised to satisfy the cluster.
        energyEvseMode: {
          supportedModes: [
            { label: 'Charging', mode: 1, modeTags: [{ value: 0 }] },
          ],
          currentMode: 1,
        },
      });
    } catch (err) {
      this.log.debug(`[matter] Could not seed EnergyEvse defaults (${err && err.message ? err.message : err}); using matter.js defaults.`);
      return deviceType;
    }
  }

  /**
   * Register the charger as a Matter accessory.
   *
   * Prefers the experimental EnergyEvse device type when `matterEvseBeta` is
   * set and the device type resolves; otherwise publishes the proven outlet.
   * If EnergyEvse registration fails for any reason, it retries as an outlet so
   * a failed experiment never leaves the charger unpublished.
   *
   * @param {string} ip - charger IP, used for the serial number / UUID seed
   * @param {string} displayName
   * @param {object} readings - initial readings to seed the clusters with
   * @returns {Promise<boolean>} whether registration succeeded
   */
  async register(ip, displayName, readings) {
    if (!this.isSupported()) return false;

    // Distinct from the HAP accessory UUID so the two never collide.
    this.uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:matter:${ip}`);

    if (this.platform.config.matterEvseBeta) {
      const evseDeviceType = await this.resolveEvseDeviceType();
      if (!evseDeviceType) {
        this.log.warn('[matter] EVSE beta is enabled but the Matter EnergyEvse device type could not be loaded from @matter/main. Publishing as an outlet instead.');
      } else {
        const composed = this.composeEvseDeviceType(evseDeviceType, readings);
        const accepted = await this._tryRegister(ip, displayName, readings, 'evse', composed);

        // registerPlatformAccessories() resolves before the Matter server
        // actually builds the endpoint, so a failure there surfaces
        // asynchronously and cannot be caught above. Confirm the accessory
        // really came up before trusting it.
        if (accepted && await this._verifyRegistered()) {
          this.registered = true;
          this.log.info('[matter] Published Tesla Wall Connector as an experimental Matter EnergyEvse device (device type 1292) and confirmed it is live. Live power and energy will update; the EnergyEvse charging state is fixed at its registered value (Homebridge cannot accept writes to that cluster). How Apple Home renders this is unverified — turn off the EVSE beta option to go back to the outlet.');
          return true;
        }

        this.registered = false;
        this.mode = null;
        this.log.warn('[matter] The EnergyEvse accessory did not come up — falling back to a regular Matter outlet so the charger still appears. Check the log above for a [Matter/Server] error, and turn off the EVSE beta option to silence this.');
      }
    }

    return this._tryRegister(ip, displayName, readings, 'outlet', this.api.matter.deviceTypes.OnOffOutlet);
  }

  /**
   * Poll for the accessory actually existing on the Matter server.
   * `getAccessoryState` resolves to undefined for an accessory that failed to
   * register, which is the signal we need.
   *
   * @returns {Promise<boolean>} whether the accessory is live
   */
  async _verifyRegistered(attempts = 6, delayMs = 1000) {
    for (let i = 0; i < attempts; i++) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        const state = await this.api.matter.getAccessoryState(this.uuid, 'electricalPowerMeasurement');
        if (state) return true;
      } catch (err) {
        this.log.debug(`[matter] Verification attempt ${i + 1} failed: ${err && err.message ? err.message : err}`);
      }
    }
    return false;
  }

  /**
   * Attempt a single registration in the given mode.
   * @returns {Promise<boolean>} success
   */
  async _tryRegister(ip, displayName, readings, mode, deviceType) {
    const isEvse = mode === 'evse';

    const accessory = {
      UUID: this.uuid,
      displayName,
      deviceType,
      serialNumber: ip,
      manufacturer: 'Tesla',
      model: 'Wall Connector Gen 3',
      context: { ip },
      // Only clusters Homebridge knows how to map to behaviors go here. In EVSE
      // mode the energyEvse/energyEvseMode state is baked into the device type
      // instead (see composeEvseDeviceType).
      clusters: this.buildClusters(readings, { includeOnOff: !isEvse }),
    };

    if (!isEvse) {
      // The Gen 3 local API is read-only: it reports status but cannot start
      // or stop charging. Accept the command so the controller isn't left
      // hanging, warn, and let the next poll push the true state back.
      accessory.handlers = {
        onOff: {
          on: async () => this._rejectControl(true),
          off: async () => this._rejectControl(false),
        },
      };
    }

    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.mode = mode;
      if (isEvse) {
        // Stay unregistered until the endpoint is confirmed live (see
        // register()). Marking it registered here would let a poll fire
        // update() during the verification window, against an accessory that
        // may still be re-registering.
        this.log.debug('[matter] EnergyEvse accessory accepted; verifying it comes up.');
      } else {
        this.registered = true;
        this.log.info('[matter] Published Tesla Wall Connector as a Matter outlet with electrical measurements — live power should appear on its tile in the Apple Home Energy view.');
      }
      return true;
    } catch (err) {
      const detail = err && err.message ? err.message : err;
      if (isEvse) {
        this.log.warn(`[matter] EnergyEvse registration failed: ${detail}`);
      } else {
        this.log.warn(`[matter] Failed to register Matter accessory (${detail}). Continuing without Matter.`);
      }
      this.registered = false;
      this.mode = null;
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
    const isEvse = this.mode === 'evse';
    const clusters = this.buildClusters(readings, { includeOnOff: !isEvse });

    // Only clusters Homebridge curates may be written.
    //
    // updateAccessoryState() adds the cluster to the accessory's cluster map,
    // and Homebridge builds the Matter endpoint by spreading that map into the
    // endpoint options (`{ id, ...accessory.clusters }`). A key that is not a
    // behavior on the device type then fails endpoint construction with
    // `"<uuid>.<cluster>" is not a Behavior.Type` — so writing `energyEvse`
    // here poisons the accessory and breaks the next re-registration.
    //
    // The consequence in EVSE mode is that the EnergyEvse charging state stays
    // at whatever was baked into the device type at registration; only the
    // electrical measurements are live. See the README.
    const writes = isEvse ? [] : [['onOff', clusters.onOff]];

    writes.push(['electricalPowerMeasurement', clusters.electricalPowerMeasurement]);
    writes.push(['electricalEnergyMeasurement', clusters.electricalEnergyMeasurement]);

    // Settled rather than all: `energyEvse` is not a cluster Homebridge curates,
    // so that write may be rejected even while the electrical measurements —
    // the readings that actually matter — go through fine. One failing cluster
    // must not mask the others.
    const results = await Promise.allSettled(
      writes.map(([cluster, attrs]) => matter.updateAccessoryState(this.uuid, cluster, attrs)),
    );

    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const cluster = writes[i][0];
      const reason = result.reason;
      const message = `[matter] Failed to update ${cluster}: ${reason && reason.message ? reason.message : reason}`;
      // Warn once per cluster, then drop to debug so a persistently unhappy
      // Matter server can't flood the log on every poll.
      if (!this._warnedUpdate[cluster]) {
        this._warnedUpdate[cluster] = true;
        this.log.warn(message);
      } else {
        this.log.debug(message);
      }
    });
  }
}

module.exports = { MatterEnergyBridge, PLUGIN_NAME, PLATFORM_NAME };
