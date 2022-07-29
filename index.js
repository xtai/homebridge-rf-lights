'use strict';

var Accessory, Service, Characteristic;
const spawn = require('child_process').spawn;
const path = require('path');
const py_args = [path.join(__dirname, './py_rf_lights.py'), '--light'];

module.exports = function (api) {
  Accessory = api.hap.Accessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform('homebridge-rf-lights', 'RFLights', RFLightsPlatform, true);
};

class RFLightsPlatform {
  constructor(log, config, api) {
    if (null == config) {
      return;
    }

    this.Accessory = Accessory;
    this.Service = Service;
    this.Characteristic = Characteristic;

    this.log = log;
    this.config = config;
    this.api = api;

    this.accessories = [];
    this.commandQueue = [];
    this.transmitting = false;
    this.state = {
      tao95: {
        measurement: 'tao95',
        time: 1658000000,
        fields: {
          power: false,
          main_power: false,
          main_brightness: 100,
          main_color_temp: 3000,
          aux_power: false,
          aux_brightness: 100,
          aux_color_temp: 3000
        }
      },
      txone: {
        measurement: 'txone',
        time: 1658000000,
        fields: {
          power: false,
          brightness: 100,
          color_temp: 3000,
          color_cycle: false
        }
      }
    };

    this.api.on('didFinishLaunching', () => {
      this.accessories.forEach((element) => {
        // remove all cached accessories
        this.api.unregisterPlatformAccessories('homebridge-rf-lights', 'RFLights', [element]);
        this.log.info(`Clear cached accessories: ${element.displayName}`);
      });
      this.initAccessory(Tao95LightAccessory, 'tao95');
      this.initAccessory(Tao95LightBreakdownAccessory, 'tao95-detail');
      this.initAccessory(Tao95RemoteAccessory, 'tao95-remote');
      this.addCommand(['tao95', '--status']);

      this.initAccessory(TxoneLightAccessory, 'txone');
      this.initAccessory(TxoneRemoteAccessory, 'txone-remote');
      this.addCommand(['txone', '--status']);
    });
  }
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
  initAccessory(AccessoryClass, label) {
    const uuid = this.api.hap.uuid.generate(label);
    // const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
    // if (existingAccessory) {
    //   this.api.unregisterPlatformAccessories('homebridge-rf-lights', 'RFLights', [existingAccessory]);
    // }
    const accessory = new this.api.platformAccessory(label, uuid);
    accessory.context.device = label;
    new AccessoryClass(this, accessory);
    this.api.registerPlatformAccessories('homebridge-rf-lights', 'RFLights', [accessory]);
  }
  nextCommand() {
    const item = this.commandQueue.shift();
    let that = this;
    if (!item || !item[0]) {
      this.log.debug('command queue empty');
      return;
    }
    const light = item[0];
    if (light === 'tao95' || light === 'txone') {
      let pythonProcess = spawn('/usr/bin/python3', py_args.concat(item));
      pythonProcess.stdout.on('data', (data) => {
        let json = JSON.parse(data);
        if (json.measurement === light) {
          that.state[light] = json;
        } else {
          that.log.error(`${light} response: ${data}`);
        }
        if (that.commandQueue.length > 0) {
          that.nextCommand.bind(that)();
        } else {
          that.transmitting = false;
        }
      });
    }
  }
  addCommand(command) {
    this.commandQueue.push(command);
    if (!this.transmitting) {
      this.transmitting = true;
      this.nextCommand.bind(this)();
    }
  }
  newButtonService(light, label, labelCode, setOn, getOn) {
    let buttonService =
      light.accessory.getService(label) || light.accessory.addService(this.Service.Switch, label, labelCode);
    buttonService.getCharacteristic(this.Characteristic.On).onSet(setOn.bind(light)).onGet(getOn.bind(light));
    return buttonService;
  }
  resetButtonTimer(light, button) {
    setTimeout(
      function () {
        button.setCharacteristic(Characteristic.On, false);
      }.bind(light),
      100
    );
  }
  newLightService(light, label, labelCode, setOn, getOn, setBrightness, getBrightness) {
    let lightService =
      light.accessory.getService(label) || light.accessory.addService(this.Service.Lightbulb, label, labelCode);
    lightService.getCharacteristic(this.Characteristic.On).onSet(setOn.bind(light)).onGet(getOn.bind(light));
    lightService
      .getCharacteristic(this.Characteristic.Brightness)
      .onSet(setBrightness.bind(light))
      .onGet(getBrightness.bind(light));
    return lightService;
  }
  addColorTempService(light, lightService, setColorTemp, getColorTemp) {
    // 360, 280, 240, 200, 160;
    // 360 <> 3000 (2700k), 280 <> 4000, 200 <> 5000, 160 <> 6000 (6200k)
    // 360 <> 3000 (2700k), 240 <> 4000, 160 <> 6000 (6200k)
    lightService
      .getCharacteristic(this.Characteristic.ColorTemperature)
      .setProps({ minValue: 160, maxValue: 360, minStep: 40 })
      .onSet(setColorTemp.bind(light))
      .onGet(getColorTemp.bind(light));
  }
  convertTao95ColorToKelvin(value) {
    // 360 <> 3000 (2700k), 280 <> 4000, 200 <> 5000, 160 <> 6000 (6200k)
    if (value < 180) {
      return 6000;
    } else if (value < 240) {
      return 5000;
    } else if (value < 320) {
      return 4000;
    } else {
      return 3000;
    }
  }
  convertTao95ColorToApple(value) {
    // 360 <> 3000 (2700k), 280 <> 4000, 200 <> 5000, 160 <> 6000 (6200k)
    if (value > 5500) {
      return 160;
    } else if (value > 4500) {
      return 200;
    } else if (value > 3500) {
      return 280;
    } else {
      return 360;
    }
  }
  convertTxoneColorToKelvin(value) {
    // 360 <> 3000 (2700k), 240 <> 4000, 160 <> 6000 (6200k)
    if (value < 200) {
      return 6000;
    } else if (value < 300) {
      return 4000;
    } else {
      return 3000;
    }
  }
  convertTxoneColorToApple(value) {
    // 360 <> 3000 (2700k), 240 <> 4000, 160 <> 6000 (6200k)
    if (value > 5000) {
      return 160;
    } else if (value > 3500) {
      return 240;
    } else {
      return 360;
    }
  }
}

class Tao95LightAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'TaoTronics')
      .setCharacteristic(this.platform.Characteristic.Model, 'TT-DL095BSPF')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '2AVUHTT-DL095-0')
      .setCharacteristic(this.platform.Characteristic.Name, 'Tao95');
    this.lightService = this.platform.newLightService(
      this,
      'Tao95 Light',
      'tao95-light',
      this.setOn,
      this.getOn,
      this.setBrightness,
      this.getBrightness
    );
    this.platform.addColorTempService(this, this.lightService, this.setColorTemp, this.getColorTemp);
  }
  setOn(value) {
    if (value !== this.platform.state.tao95.fields.power) {
      if (value) {
        this.platform.addCommand(['tao95', '--on']);
      } else if (value === false) {
        this.platform.addCommand(['tao95', '--off']);
      }
    }
  }
  getOn() {
    return this.platform.state.tao95.fields.power;
  }
  setBrightness(value) {
    const brightness = this.separateTao95Brightness(value);
    if (value > 0) {
      if (brightness['main'] === 0 && this.platform.state.tao95.fields.main_power) {
        this.platform.addCommand(['tao95', '--part', 'main', '--off']);
      } else if (brightness['main'] !== this.platform.state.tao95.fields.main_brightness) {
        this.platform.addCommand(['tao95', '--part', 'main', '--brightness', brightness['main'].toString()]);
      }
      if (brightness['aux'] === 0 && this.platform.state.tao95.fields.aux_power) {
        this.platform.addCommand(['tao95', '--part', 'aux', '--off']);
      } else if (brightness['aux'] !== this.platform.state.tao95.fields.aux_brightness) {
        this.platform.addCommand(['tao95', '--part', 'aux', '--brightness', brightness['aux'].toString()]);
      }
    }
  }
  getBrightness() {
    return this.mergeTao95Brightness(
      this.platform.state.tao95.fields.main_power,
      this.platform.state.tao95.fields.main_brightness,
      this.platform.state.tao95.fields.aux_power,
      this.platform.state.tao95.fields.aux_brightness
    );
  }
  setColorTemp(value) {
    if (
      value >= 160 &&
      value <= 360 &&
      (value !== this.platform.convertTao95ColorToApple(this.platform.state.tao95.fields.main_color_temp) ||
        value !== this.platform.convertTao95ColorToApple(this.platform.state.tao95.fields.aux_color_temp))
    ) {
      this.platform.addCommand(['tao95', '--colortemp', this.platform.convertTao95ColorToKelvin(value).toString()]);
    }
  }
  getColorTemp() {
    return parseInt(
      this.platform.convertTao95ColorToApple(
        parseInt(
          (this.platform.state.tao95.fields.main_color_temp + this.platform.state.tao95.fields.aux_color_temp) / 2
        )
      )
    );
  }
  mergeTao95Brightness(main_power, main, aux_power, aux) {
    if (!main_power) {
      main = 0;
    }
    if (!aux_power) {
      aux = 0;
    }
    return parseInt(main / 25) * 20 + parseInt(aux / 25) * 5;
  }
  separateTao95Brightness(value) {
    return {
      main: parseInt((value - 5) / 20) * 25,
      aux: (parseInt(((value - 5) % 20) / 5) + 1) * 25
    };
  }
}

class Tao95LightBreakdownAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'TaoTronics')
      .setCharacteristic(this.platform.Characteristic.Model, 'TT-DL095BSPF')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '2AVUHTT-DL095-1')
      .setCharacteristic(this.platform.Characteristic.Name, 'Tao95 Lights');
    this.mainLightService = this.platform.newLightService(
      this,
      'Main Light',
      'tao95-main-light',
      this.setMainOn,
      this.getMainOn,
      this.setMainBrightness,
      this.getMainBrightness
    );
    this.auxLightService = this.platform.newLightService(
      this,
      'Aux Light',
      'tao95-aux-light',
      this.setAuxOn,
      this.getAuxOn,
      this.setAuxBrightness,
      this.getAuxBrightness
    );
  }

  setMainOn(value) {
    if (value !== this.platform.state.tao95.fields.main_power) {
      if (value) {
        this.platform.addCommand(['tao95', '--part', 'main', '--on']);
      } else if (value === false) {
        this.platform.addCommand(['tao95', '--part', 'main', '--off']);
      }
    }
  }
  getMainOn() {
    return this.platform.state.tao95.fields.main_power;
  }
  setMainBrightness(value) {
    if (value > 0 && value !== this.platform.state.tao95.fields.main_brightness) {
      this.platform.addCommand(['tao95', '--part', 'main', '--brightness', value.toString()]);
    }
  }
  getMainBrightness() {
    return parseInt(this.platform.state.tao95.fields.main_brightness);
  }

  setAuxOn(value) {
    if (value !== this.platform.state.tao95.fields.main_power) {
      if (value) {
        this.platform.addCommand(['tao95', '--part', 'aux', '--on']);
      } else if (value === false) {
        this.platform.addCommand(['tao95', '--part', 'aux', '--off']);
      }
    }
  }
  getAuxOn() {
    return this.platform.state.tao95.fields.aux_power;
  }
  setAuxBrightness(value) {
    if (value > 0 && value !== this.platform.state.tao95.fields.aux_brightness) {
      this.platform.addCommand(['tao95', '--part', 'aux', '--brightness', value.toString()]);
    }
  }
  getAuxBrightness() {
    return parseInt(this.platform.state.tao95.fields.aux_brightness);
  }
}

class Tao95RemoteAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'TaoTronics')
      .setCharacteristic(this.platform.Characteristic.Model, 'Tao95 Remote')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '2AVUHTT-DL095')
      .setCharacteristic(this.platform.Characteristic.Name, 'Tao95 Remote');
    this.button0 = this.platform.newButtonService(this, 'Power', 'tao95-remote-btn-0', this.setButton0, this.getOn);
    this.button1 = this.platform.newButtonService(this, 'Main', 'tao95-remote-btn-1', this.setButton1, this.getOn);
    this.button2 = this.platform.newButtonService(
      this,
      'Main Color',
      'tao95-remote-btn-2',
      this.setButton2,
      this.getOn
    );
    this.button3 = this.platform.newButtonService(this, 'Aux', 'tao95-remote-btn-3', this.setButton3, this.getOn);
    this.button4 = this.platform.newButtonService(this, 'Aux Color', 'tao95-remote-btn-4', this.setButton4, this.getOn);
    this.buttonSync = this.platform.newButtonService(
      this,
      'Sync',
      'tao95-remote-btn-sync',
      this.setButtonSync,
      this.getOn
    );
  }
  setButton0(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--button', '0']);
      this.platform.resetButtonTimer(this, this.button0);
    }
  }
  setButton1(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--button', '1']);
      this.platform.resetButtonTimer(this, this.button1);
    }
  }
  setButton2(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--button', '2']);
      this.platform.resetButtonTimer(this, this.button2);
    }
  }
  setButton3(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--button', '3']);
      this.platform.resetButtonTimer(this, this.button3);
    }
  }
  setButton4(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--button', '4']);
      this.platform.resetButtonTimer(this, this.button4);
    }
  }
  setButtonSync(value) {
    if (value) {
      this.platform.addCommand(['tao95', '--sync']);
      this.platform.resetButtonTimer(this, this.buttonSync);
    }
  }
  getOn() {
    return false;
  }
}

class TxoneLightAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Txone')
      .setCharacteristic(this.platform.Characteristic.Model, 'Modern Floor Lamp')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'B08M95NB7B')
      .setCharacteristic(this.platform.Characteristic.Name, 'Txone');
    this.lightService = this.platform.newLightService(
      this,
      'Txone Light',
      'txone-light',
      this.setOn,
      this.getOn,
      this.setBrightness,
      this.getBrightness
    );
    this.platform.addColorTempService(this, this.lightService, this.setColorTemp, this.getColorTemp);
  }
  setOn(value) {
    if (value !== this.platform.state.txone.fields.power) {
      if (value) {
        this.platform.addCommand(['txone', '--on']);
      } else if (value === false) {
        this.platform.addCommand(['txone', '--off']);
      }
    }
  }
  getOn() {
    return this.platform.state.txone.fields.power;
  }
  setBrightness(value) {
    if (value > 0 && value !== this.platform.state.txone.fields.brightness) {
      this.platform.addCommand(['txone', '--brightness', value.toString()]);
    }
  }
  getBrightness() {
    return parseInt((this.platform.state.txone.fields.brightness + 5) / 10) * 10;
  }
  setColorTemp(value) {
    if (
      value >= 160 &&
      value <= 360 &&
      value !== this.platform.convertTxoneColorToApple(this.platform.state.txone.fields.color_temp)
    ) {
      this.platform.addCommand(['txone', '--colortemp', this.platform.convertTxoneColorToKelvin(value).toString()]);
    }
  }
  getColorTemp() {
    return parseInt(this.platform.convertTxoneColorToApple(parseInt(this.platform.state.txone.fields.color_temp)));
  }
}

class TxoneRemoteAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Txone')
      .setCharacteristic(this.platform.Characteristic.Model, 'Modern Floor Lamp')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'B08M95NB7B')
      .setCharacteristic(this.platform.Characteristic.Name, 'Txone Remote');
    this.button0 = this.platform.newButtonService(
      this,
      '0 Power On',
      'txone-remote-btn-0',
      this.setButton0,
      this.getOn
    );
    this.button1 = this.platform.newButtonService(
      this,
      '0 Power Off',
      'txone-remote-btn-1',
      this.setButton1,
      this.getOn
    );
    this.button2 = this.platform.newButtonService(
      this,
      'Increase Brightness',
      'txone-remote-btn-2',
      this.setButton2,
      this.getOn
    );
    this.button3 = this.platform.newButtonService(
      this,
      'Decrease Brightness',
      'txone-remote-btn-3',
      this.setButton3,
      this.getOn
    );
    this.button4 = this.platform.newButtonService(this, 'L Cycle', 'txone-remote-btn-4', this.setButton4, this.getOn);
    this.button5 = this.platform.newButtonService(this, 'L Warm', 'txone-remote-btn-5', this.setButton5, this.getOn);
    this.button6 = this.platform.newButtonService(this, 'L Neutral', 'txone-remote-btn-6', this.setButton6, this.getOn);
    this.button7 = this.platform.newButtonService(this, 'L Cool', 'txone-remote-btn-7', this.setButton7, this.getOn);
    this.buttonSync = this.platform.newButtonService(
      this,
      'Sync',
      'txone-remote-btn-sync',
      this.setButtonSync,
      this.getOn
    );
  }
  setButton0(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '0']);
      this.platform.resetButtonTimer(this, this.button0);
    }
  }
  setButton1(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '1']);
      this.platform.resetButtonTimer(this, this.button1);
    }
  }
  setButton2(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '2']);
      this.platform.resetButtonTimer(this, this.button2);
    }
  }
  setButton3(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '3']);
      this.platform.resetButtonTimer(this, this.button3);
    }
  }
  setButton4(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '4']);
      this.platform.resetButtonTimer(this, this.button4);
    }
  }
  setButton5(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '5']);
      this.platform.resetButtonTimer(this, this.button5);
    }
  }
  setButton6(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '6']);
      this.platform.resetButtonTimer(this, this.button6);
    }
  }
  setButton7(value) {
    if (value) {
      this.platform.addCommand(['txone', '--button', '7']);
      this.platform.resetButtonTimer(this, this.button7);
    }
  }
  setButtonSync(value) {
    if (value) {
      this.platform.addCommand(['txone', '--sync']);
      this.platform.resetButtonTimer(this, this.buttonSync);
    }
  }
  getOn() {
    return false;
  }
}
