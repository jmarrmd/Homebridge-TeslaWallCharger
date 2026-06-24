# homebridge-tesla-wall-connector

[![npm version](https://img.shields.io/npm/v/homebridge-tesla-wall-connector.svg)](https://www.npmjs.com/package/homebridge-tesla-wall-connector)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-tesla-wall-connector.svg)](https://www.npmjs.com/package/homebridge-tesla-wall-connector)
[![Homebridge](https://img.shields.io/badge/homebridge-1.8%20%7C%202.0-blue.svg)](https://homebridge.io)

A [Homebridge](https://homebridge.io) plugin that exposes a **Tesla Wall Connector (Gen 3)** in Apple HomeKit using the charger's **local API** — no Tesla account, cloud login, or internet round-trip required.

It surfaces live charging status and electrical readings (voltage, current, power, energy) and is **forward-ready for the Apple Home Energy view** via Matter once Homebridge supports the Matter energy device types.

> **Read-only:** this plugin *reports* what the charger is doing — it does not start or stop charging. The Gen 3 Wall Connector's local `/vitals` API is monitoring-only.

---

## Features

- 🔌 **Outlet accessory** in the Home app
  - **On** → the charger is actively delivering power (contactor closed)
  - **In Use** → a vehicle is plugged in
- ⚡ **Live electrical readings** as Eve-compatible characteristics
  - Voltage (V), Current (A), Power (W), and cumulative Energy (kWh)
  - Viewable with history graphs in the [Eve app](https://www.evehome.com/en/eve-app), Controller for HomeKit, Home+, etc.
- 🏠 **Local & private** — polls the charger directly on your LAN
- 🔋 **Matter-ready** — optional, forward-compatible scaffolding to appear in the native Apple Home **Energy** view (iOS 27+) once Homebridge exposes the Matter energy device types ([homebridge#3942](https://github.com/homebridge/homebridge/issues/3942))
- 🧩 Works on **Homebridge 1.8+ and Homebridge 2.0** (HAP-NodeJS v1)

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
| `matter`       | boolean   | ❌       | `false`                 | Opt in to the Matter EnergyEvse readiness shim (see [Apple Home Energy & Matter](#apple-home-energy--matter)). Safe to enable ahead of platform support — it's a no-op until Homebridge exposes the API. |

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

iOS 27 adds a native **Energy** view to the Apple Home app — but it is driven by **Matter** energy device types, **not** by classic HomeKit/HAP characteristics. That means the Eve characteristics above (which only Eve-class apps read) will **not** populate Apple's native Energy tile.

A Tesla Wall Connector is a perfect match for the Matter **`EnergyEvse`** (Electric Vehicle Supply Equipment) device type, and its readings map cleanly onto the Matter electrical-measurement clusters:

| Wall Connector reading | Matter mapping |
| ---------------------- | -------------- |
| `grid_v`               | Electrical Power Measurement → `voltage` |
| `vehicle_current_a`    | Electrical Power Measurement → `activeCurrent` |
| power (`V × A`)        | Electrical Power Measurement → `activePower` |
| `session_energy_wh`    | Electrical Energy Measurement → `cumulativeEnergyImported` |

The blocker today is upstream: Homebridge bundles the Matter libraries but does not yet expose the energy device types through its public API ([homebridge#3942](https://github.com/homebridge/homebridge/issues/3942)).

This plugin ships a **forward-compatible shim** (`matterEnergy.js`). When you set `"matter": true`:

- On **current** Homebridge builds it is a **guaranteed no-op** — it detects that the Matter energy API is absent and does nothing.
- Once Homebridge exposes the energy device types, it **automatically** registers the charger as a Matter `EnergyEvse` device so it appears in the Apple Home Energy view — **no plugin update or config change required.**

You can safely turn it on now to be ready.

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

This project does not yet declare a license. If you intend others to use or contribute, consider adding one (e.g. [MIT](https://choosealicense.com/licenses/mit/) or [Apache-2.0](https://choosealicense.com/licenses/apache-2.0/)) and a matching `license` field in `package.json`.
