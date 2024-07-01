import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { RFLightsPlatform } from './platform.js';

export class LightAccessory {
  private light: string;

  constructor(private readonly platform: RFLightsPlatform, private readonly accessory: PlatformAccessory) {
    this.light = accessory.context.device.deviceName;
    this.platform.RecordKeeper.initState(this.light);

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bao Co.')
      .setCharacteristic(this.platform.Characteristic.Model, this.accessory.context.device.deviceLabel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.context.serial);

    const parts = this.accessory.context.part ? this.accessory.context.device.parts : [{ partName: 'default' }];
    for (const part of parts) {
      this.setupLightService(part.partName);
    }
  }

  private setupLightService(part: string) {
    const id = `${this.light}-${part}`;
    const service = this.accessory.getService(id) || this.accessory.addService(this.platform.Service.Lightbulb, id, id);
    service.setCharacteristic(this.platform.Characteristic.Name, id);

    if (part !== 'default') {
      service.setCharacteristic(this.platform.Characteristic.ConfiguredName, part);
    }

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this, id, part))
      .onGet(this.getOn.bind(this, id));

    service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this, id, part))
      .onGet(this.getBrightness.bind(this, id));
  }

  private async getOn(id: string): Promise<CharacteristicValue> {
    const isOn = this.platform.RecordKeeper.getState(id).On;
    this.platform.log.debug(id, 'get On ->', isOn);
    return isOn;
  }

  private async setOn(id: string, part: string, value: CharacteristicValue) {
    const currentPower = this.platform.RecordKeeper.getState(id).On;
    if (value != currentPower) {
      this.platform.RecordKeeper.controlPower(id, value as boolean, this.light, [
        '--part',
        part,
        value ? '--on' : '--off'
      ]);
    }
    this.platform.log.debug(id, 'set On ->', value);
  }

  private async getBrightness(id: string): Promise<CharacteristicValue> {
    let brightness = 0;
    if (this.platform.RecordKeeper.getState(id).On) {
      brightness = this.platform.RecordKeeper.getState(id).Brightness;
    }
    this.platform.log.debug(id, 'get Brightness ->', brightness);
    return brightness;
  }

  private async setBrightness(id: string, part: string, value: CharacteristicValue) {
    const currentBrightness = this.platform.RecordKeeper.getState(id).Brightness;
    if (value !== 0 && value !== currentBrightness) {
      this.platform.RecordKeeper.controlBrightness(id, value as number, this.light, [
        '--part',
        part,
        '--brightness',
        value as string
      ]);
    }
    this.platform.log.debug(id, 'set Brightness ->', value);
  }
}
