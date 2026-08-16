# homebridge-tesla-wall-connector

[![npm version](https://img.shields.io/npm/v/homebridge-tesla-wall-connector.svg)](https://www.npmjs.com/package/homebridge-tesla-wall-connector)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-tesla-wall-connector.svg)](https://www.npmjs.com/package/homebridge-tesla-wall-connector)
[![Homebridge](https://img.shields.io/badge/homebridge-1.8%20%7C%202.0-blue.svg)](https://homebridge.io)

A [Homebridge](https://homebridge.io) plugin that exposes a **Tesla Wall Connector (Gen 3)** in Apple HomeKit using the charger's **local API** — no Tesla account, cloud login, or internet round-trip required.

It surfaces live charging status and electrical readings (voltage, current, power, energy), and can optionally publish itself over **Matter** so it appears in the **Apple Home Energy view** with live watts on its tile.

> **Read-only:** this plugin *reports* what the charger is doing — it does not start or stop charging. The Gen 3 Wall Connector's local `/vitals` API is monitoring-only.

---

## Features

The plugin publishes **exactly one accessory**, over one of two transports — pick with the `matter` option:

**HomeKit mode** (default, `"matter": false`)

- 🔌 **Outlet accessory** in the Home app
  - **On** → the charger is actively delivering power (contactor closed)
  - **In Use** → a vehicle is plugged in
- ⚡ **Live electrical readings** as Eve-compatible characteristics
  - Voltage (V), Current (A), Power (W), and cumulative Energy (kWh)
  - Viewable with history graphs in the [Eve app](https://www.evehome.com/en/eve-app), Controller for HomeKit, Home+, etc.

**Matter mode** (`"matter": true`)

- 🔋 **Apple Home Energy view** — publishes as a Matter outlet carrying `ElectricalPowerMeasurement` / `ElectricalEnergyMeasurement`, so live watts show on the tile and consumption feeds your home energy total
- Requires Homebridge 2.3.0+ with Matter enabled; the Eve characteristics are HAP-only and are **not** available in this mode

**Both modes**

- 🏠 **Local & private** — polls the charger directly on your LAN
- 🧩 Works on **Homebridge 1.8+ and Homebridge 2.x** (HAP-NodeJS v1)

---

## Requirements

- A **Tesla Wall Connector Gen 3** on the same network as your Homebridge host
  > Earlier Wall Connectors (Gen 1/2) do **not** expose the local `/api/1/vitals` endpoint and are not supported.
- **Node.js** ≥ 18.20.0
- **Homebridge** ≥ 1.8.0 (including 2.0)

---

## Installation

### Homebridge UI (recommended)

1. Open the **Homebridge UI** → **Plugins** tab.
2. Search for **`homebridge-tesla-wall-connector`**.
3. Click **Install**, then configure it (see below).

### Command line

```bash
npm install -g homebridge-tesla-wall-connector
```

---

## Configuration

Add a platform block to the `platforms` array of your Homebridge `config.json`, or use the settings form in the Homebridge UI.

```json
{
  "platforms": [
    {
      "platform": "TeslaWallConnector",
      "name": "Tesla Wall Connector",
      "ipAddress": "192.168.1.50",
      "pollInterval": 30000,
      "matter": false
    }
  ]
}
```

### Options

| Option         | Type      | Required | Default                 | Description |
| -------------- | --------- | :------: | ----------------------- | ----------- |
| `platform`     | string    | ✅       | —                       | Must be `TeslaWallConnector`. |
| `name`         | string    | ✅       | `"Tesla Wall Connector"`| Accessory name shown in the Home app. |
| `ipAddress`    | string    | ✅       | —                       | Local IP address of the Wall Connector. |
| `pollInterval` | number    | ❌       | `30000`                 | How often to poll the charger, in milliseconds (minimum 5000). |
| `matter`       | boolean   | ❌       | `false`                 | Publish over **Matter instead of HomeKit**, so the charger appears in the Apple Home Energy view (see [Apple Home Energy & Matter](#apple-home-energy--matter)). Requires Homebridge 2.3.0+ with Matter enabled; falls back to HomeKit if unavailable. The Eve characteristics are not available in this mode. |

### Finding your Wall Connector's IP address

- Check your **router's DHCP client list** for the Wall Connector, **or**
- Open the **Tesla app** → your Wall Connector → device details, **or**
- Connect to the charger's built-in Wi-Fi access point during setup.

Then verify the local API is reachable from your Homebridge host:

```bash
curl http://<charger-ip>/api/1/vitals
```

You should get a JSON response containing fields like `contactor_closed`, `vehicle_connected`, `grid_v`, `vehicle_current_a`, and `session_energy_wh`.

> 💡 **Tip:** assign the Wall Connector a **static IP / DHCP reservation** in your router so its address doesn't change and break the plugin.

---

## How it appears in HomeKit

*(HomeKit mode — the default. For Matter mode see [below](#apple-home-energy--matter).)*

The charger shows up as an **Outlet**:

| HomeKit state | Meaning |
| ------------- | ------- |
| **On**        | The charger is actively supplying power (contactor closed / charging). |
| **In Use**    | A vehicle is plugged in. |

The electrical readings are attached as **Eve custom characteristics**. Apple's built-in Home app does not render these, so to see Voltage / Current / Power / Energy and their history, use an app that understands the Eve characteristics:

- [Eve for HomeKit](https://www.evehome.com/en/eve-app)
- Controller for HomeKit
- Home+

---

## Apple Home Energy & Matter

Apple Home's native **Energy** view is driven by **Matter** electrical-measurement clusters, **not** by classic HomeKit/HAP characteristics. HAP has no power or energy characteristic at all, so the Eve characteristics above (which only Eve-class apps read) can never populate it — no matter how the HomeKit accessory is shaped.

Homebridge 2.2.0 added the Matter electrical measurement clusters to its plugin API, and 2.3.0 fixed the composition and bridge-online behavior needed to use them. With `"matter": true`, this plugin publishes the charger over Matter — **instead of** over HomeKit — as an **outlet carrying live electrical measurements**:

| Wall Connector reading | Matter cluster attribute | Unit sent |
| ---------------------- | ------------------------ | --------- |
| `grid_v`               | `electricalPowerMeasurement.voltage` | mV |
| `vehicle_current_a`    | `electricalPowerMeasurement.activeCurrent` | mA |
| power (`V × A`)        | `electricalPowerMeasurement.activePower` | mW |
| `session_energy_wh`    | `electricalEnergyMeasurement.cumulativeEnergyImported.energy` | mWh |
| `contactor_closed`     | `onOff.onOff` | — |

### Requirements

- **Homebridge 2.3.0 or later**
- **Matter enabled on this plugin's child bridge** — in the Homebridge UI: plugin settings → **Bridge Settings** → enable Matter, then pair the Matter bridge in the Home app
- An Apple Home setup on **iOS/tvOS 26 or later** for the Energy view itself

If the Matter API isn't available (older Homebridge, or Matter not enabled), the plugin logs a warning and **falls back to publishing over HomeKit**, so the charger always appears somewhere.

### Switching modes

Only one accessory is ever published, so turning `matter` on removes the cached HomeKit accessory (otherwise it would linger in the Home app as an unresponsive duplicate). Because the two are different accessories, switching either way means the old one disappears and a new one appears — **you'll need to re-assign its room, rename it, and re-create any automations that referenced it.** The trade-off is one clean tile instead of two.

Note also that the **Eve characteristics are HAP-only**: in Matter mode you gain the Apple Home Energy view but lose the Eve app's voltage/current/power history graphs. If that history matters more to you than the Energy tile, stay in HomeKit mode.

### What to expect

Live watts appear on the accessory's tile, and its consumption is counted toward your home's energy total. Note that Apple currently reserves the **per-device listing** in the Energy breakdown for certified, natively-paired Matter devices — bridged accessories like this one contribute to the total and show on their own tile, but may not get their own row in that list.

### Read-only

The Gen 3 local API reports status but cannot start or stop charging, so the Matter outlet is effectively read-only. If you toggle it in the Home app, the plugin logs a warning and the next poll restores the true state.

---

## Troubleshooting

**`No IP Address configured for Tesla Wall Connector`**
Set the `ipAddress` option to your charger's local IP.

**`Failed to poll http://<ip>/api/1/vitals`**
- Confirm Homebridge and the charger are on the same network/VLAN.
- Test reachability: `curl http://<ip>/api/1/vitals`.
- Make sure the IP hasn't changed (use a DHCP reservation).
- Confirm it's a **Gen 3** Wall Connector — older models lack the local API.

**Voltage / current / power don't show in the Apple Home app**
This is expected — Apple's Home app doesn't display these custom characteristics. Use the Eve app (or another Eve-aware app). For the *native* Energy view, see [Apple Home Energy & Matter](#apple-home-energy--matter).

**Toggling the outlet doesn't start/stop charging**
By design — this plugin is read-only and reflects status; the local `/vitals` API does not control charging.

---

## Contributing

Issues and pull requests are welcome at
[github.com/jmarrmd/Homebridge-TeslaWallCharger](https://github.com/jmarrmd/Homebridge-TeslaWallCharger).

---

## Disclaimer

This is an unofficial, community-built plugin and is **not affiliated with, endorsed by, or supported by Tesla, Inc.** "Tesla" and "Wall Connector" are trademarks of Tesla, Inc. Use at your own risk.

## License

Released under the [MIT License](LICENSE).
