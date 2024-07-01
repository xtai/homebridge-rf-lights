import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { RecordKeeper } from './recordKeeper.js';
import { LightAccessory } from './lightAccessory.js';
import { RemoteAccessory } from './remoteAccessory.js';

export class RFLightsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public RecordKeeper: RecordKeeper;

  constructor(public readonly log: Logging, public readonly config: PlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log.debug('Finished initializing platform:', this.config.name);

    this.RecordKeeper = new RecordKeeper(this.config.scriptDir);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      // this.accessories.forEach((accessory: PlatformAccessory) => {
      //   this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      //   this.log.debug(`Clear cached accessories: ${accessory.displayName}`);
      // });
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    if (!this.config?.devices) {
      this.log.error('No configuration found or devices are undefined.');
      return;
    }

    for (const device of this.config.devices) {
      const { deviceId, deviceName, deviceLabel, parts, remote } = device;
      if (!deviceId || !deviceName || !deviceLabel) {
        this.log.error('Device configuration is missing required properties for device');
        continue;
      }

      const uuid = this.api.hap.uuid.generate(deviceId);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`Restoring existing accessory from cache: ${deviceLabel}`);
        existingAccessory.context.device = device;
        new LightAccessory(this, existingAccessory);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`Adding new accessory: ${deviceLabel}`);
        const accessory = new this.api.platformAccessory(deviceLabel, uuid);
        accessory.context.device = device;
        accessory.context.serial = deviceId;
        new LightAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      if (parts) this.setupParts(device, deviceId, deviceLabel);
      if (remote) this.setupRemote(device, deviceId, deviceLabel);
    }
  }

  private setupParts(device: any, deviceId: string, deviceLabel: string) {
    const uuid = this.api.hap.uuid.generate(`${deviceId}-parts`);
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info(`Restoring existing parts accessory from cache: ${deviceLabel} Parts`);
      existingAccessory.context.device = device;
      new LightAccessory(this, existingAccessory);
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      this.log.info(`Adding new parts accessory: ${deviceLabel} Parts`);
      const accessory = new this.api.platformAccessory(`${deviceLabel} Parts`, uuid);
      accessory.context.device = device;
      accessory.context.serial = `${deviceId}-parts`;
      accessory.context.part = true;
      new LightAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
  }

  private setupRemote(device: any, deviceId: string, deviceLabel: string) {
    const uuid = this.api.hap.uuid.generate(`${deviceId}-remote`);
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info(`Restoring existing remote accessory from cache: ${deviceLabel} Remote`);
      existingAccessory.context.device = device;
      new RemoteAccessory(this, existingAccessory);
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      this.log.info(`Adding new remote accessory: ${deviceLabel} Remote`);
      const accessory = new this.api.platformAccessory(`${deviceLabel} Remote`, uuid);
      accessory.context.serial = `${deviceId}-remote`;
      accessory.context.device = device;
      new RemoteAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
  }
}
