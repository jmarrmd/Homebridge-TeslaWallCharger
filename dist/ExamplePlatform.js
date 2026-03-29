"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExamplePlatform = void 0;
const settings_1 = require("./settings");
const ExampleAccessory_1 = require("./ExampleAccessory");
/**
 * HomebridgePlatform
 * This class is the main constructor for your platform plugin.
 */
class ExamplePlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        // This is used to track restored cached accessories
        this.accessories = [];
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.log.debug('Finished initializing platform:', this.config.platform);
        // When this event is fired it means Homebridge has restored all cached accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            // Run the method to discover devices, which must be called after didFinishLaunching
            this.discoverDevices();
        });
    }
    /**
     * This function is invoked when Homebridge restores cached accessories from disk at startup.
     */
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        // Add the restored accessory to the accessories cache so we can track it
        this.accessories.push(accessory);
    }
    /**
     * This is where you would discover accessosories and register them.
     */
    discoverDevices() {
        // EXAMPLE: Pretend we discovered one device from an external API
        const exampleDevices = [
            {
                uniqueId: 'ABC-123',
                name: 'Living Room Light',
                // other device properties...
            },
        ];
        // Loop over the discovered devices
        for (const device of exampleDevices) {
            // Generate a unique ID for the accessory using the UUID class
            const uuid = this.api.hap.uuid.generate(device.uniqueId);
            // Check if the accessory already exists in the cache
            const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
            if (existingAccessory) {
                // The accessory already exists
                this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                // Update context and initialize the accessory handler
                existingAccessory.context.device = device;
                new ExampleAccessory_1.ExampleAccessory(this, existingAccessory);
            }
            else {
                // The accessory does not yet exist, so create a brand new one
                this.log.info('Adding new accessory:', device.name);
                // Create a new accessory object
                const accessory = new this.api.platformAccessory(device.name, uuid);
                // Store the device details in the accessory's context
                accessory.context.device = device;
                // Create the accessory handler
                new ExampleAccessory_1.ExampleAccessory(this, accessory);
                // Register the new accessory with Homebridge
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
        }
    }
}
exports.ExamplePlatform = ExamplePlatform;
//# sourceMappingURL=ExamplePlatform.js.map