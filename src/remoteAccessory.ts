import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { RFLightsPlatform } from './platform.js';

export class RemoteAccessory {
  private light: string;

  constructor(private readonly platform: RFLightsPlatform, private readonly accessory: PlatformAccessory) {
    this.light = accessory.context.device.deviceName;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bao Co.')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.accessory.context.device.deviceLabel} Remote`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.context.serial);
    for (const [i, button] of this.accessory.context.device.remote.entries()) {
      this.setupSwitchService(i + ' ' + button.buttonName, button.buttonID);
    }
    this.setupSwitchService(this.accessory.context.device.remote.length + ' Sync', 'sync');
  }

  private setupSwitchService(buttonName: string, buttonID: string) {
    const id = `${this.light}-remote-${buttonName}-${buttonID}`;
    const service =
      this.accessory.getService(buttonName) || this.accessory.addService(this.platform.Service.Switch, buttonName, id);

    service
      .setCharacteristic(this.platform.Characteristic.Name, buttonName)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, buttonName);

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this, service, buttonID))
      .onGet(() => false);
  }

  private async setOn(service: Service, buttonID: string, value: CharacteristicValue) {
    if (value === true) {
      buttonID === 'sync'
        ? this.platform.RecordKeeper.sync(this.light)
        : this.platform.RecordKeeper.remote(this.light, buttonID);
      setTimeout(() => service.setCharacteristic(this.platform.Characteristic.On, false), 100);
    }
    this.platform.log.debug(this.light, buttonID, 'set On ->', value);
  }
}
