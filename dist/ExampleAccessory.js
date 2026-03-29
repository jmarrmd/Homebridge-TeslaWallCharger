"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExampleAccessory = void 0;
/**
 * Platform Accessory Class
 * An instance of this class is created for each accessory the platform registers.
 * It contains the code that converts HomeKit requests into device-specific commands.
 */
class ExampleAccessory {
    constructor(platform, accessory) {
        this.platform = platform;
        this.accessory = accessory;
        // Track the accessory's current state
        this.exampleStates = {
            On: false,
            Brightness: 100,
        };
        // Set the accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Example Manufacturer')
            .setCharacteristic(this.platform.Characteristic.Model, 'Example Switch')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'A1B2C3D4E5');
        // Get the Lightbulb service if it exists, otherwise create a new Lightbulb service.
        // HomeKit will see this accessory as a lightbulb.
        this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);
        // Set the service name, which is what is displayed in the Home app
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);
        // Register handlers for the On/Off Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.On)
            .on('set', this.setOn.bind(this))
            .on('get', this.getOn.bind(this));
        // Register handlers for the Brightness Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.Brightness)
            .on('set', this.setBrightness.bind(this))
            .on('get', this.getBrightness.bind(this));
    }
    /**
     * Handle requests to set the "On" characteristic
     */
    setOn(value, callback) {
        this.exampleStates.On = value;
        this.platform.log.info('Set Characteristic On ->', value);
        // Here is where you would send the command to your actual device
        callback(null); // Signal that the request was successful
    }
    /**
     * Handle requests to get the current value of the "On" characteristic
     */
    getOn(callback) {
        const isOn = this.exampleStates.On;
        this.platform.log.info('Get Characteristic On ->', isOn);
        // Here is where you would get the current state from your actual device
        callback(null, isOn); // Return the current state
    }
    /**
     * Handle requests to set the "Brightness" characteristic
     */
    setBrightness(value, callback) {
        this.exampleStates.Brightness = value;
        this.platform.log.info('Set Characteristic Brightness ->', value);
        // Here is where you would send the command to set brightness on your actual device
        callback(null);
    }
    /**
     * Handle requests to get the current value of the "Brightness" characteristic
     */
    getBrightness(callback) {
        const brightness = this.exampleStates.Brightness;
        this.platform.log.info('Get Characteristic Brightness ->', brightness);
        // Here is where you would get the current state from your actual device
        callback(null, brightness);
    }
}
exports.ExampleAccessory = ExampleAccessory;
//# sourceMappingURL=ExampleAccessory.js.map