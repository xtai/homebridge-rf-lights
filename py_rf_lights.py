#!/usr/bin/env python3

import argparse
import signal
import time
import json
import sys
import logging
import RPi.GPIO as GPIO
from influxdb import InfluxDBClient
from datetime import datetime
from collections import namedtuple

Protocol = namedtuple('Protocol',
                      ['length',
                       'sync_high', 'sync_low',
                       'zero_high', 'zero_low',
                       'one_high', 'one_low'])
PROTOCOLS = (Protocol(50, 7, 159, 7, 19, 21, 5),  # TAO95
             Protocol(390, 1, 31, 1, 3, 3, 1))    # TXLINE

TAO95 = {
  'PNUM': 0,               # Protocol(50, 7, 159, 7, 19, 21, 5)
  'BTN_CODES': [4000000,   # 0: all power
                4000000,   # 1: main brightness
                4000000,   # 2: main color temp
                4000000,   # 3: aux brightness
                4000000],  # 4: aux color temp
  'BTN_CODE_LEN': 32,
  'SYNC_CODE': 'S00000000',  # special sync code
  'DEFAULT_REPEAT': 3,       # ~0.23s
  'HOLD_REPEAT': 16,         # ~1.06s
  'COMMAND_DELAY': 0.2,      # for repeated command interval
  'BRIGHTNESS': {
    'LOW': 25,
    'MED': 50,
    'HIGH': 75,
    'FULL': 100
  },
  'COLOR_TEMPS': {
    'WARM': 3000,
    'NEUTRAL': 4000,
    'COOLER': 5000,
    'COOL': 6000
  }
}

TXONE = {
  'PNUM': 1,               # Protocol(390, 1, 31, 1, 3, 3, 1)
  'BTN_CODES': [3000000,   # 0: power on
                3000000,   # 1: power off
                3000000,   # 2: brightness +
                3000000,   # 3: brightness -
                3000000,   # 4: 4K @ 30, cycle 4K->6K->3K->4K
                3000000,   # 5: 3K @ 100
                3000000,   # 6: 4K @ 100
                3000000],  # 7: 6K @ 100
  'BTN_CODE_LEN': 24,
  'SYNC_CODE': 'S',
  'DEFAULT_REPEAT': 3,     # ~0.23s
  'POWER_REPEAT': 5,       # ~0.5s special for power command
  'COMMAND_DELAY': 0.2,    # for repeated command interval
  'BRIGHTNESS_TIER': [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100],  # 3/6k from 100%
                      [10, 29, 39, 49, 59, 69, 79, 89, 100],  # 3/6k from 10%
                      [10, 18, 28, 38, 48, 58, 68, 78, 88, 98, 100]],  # 4k
  'COLOR_TEMPS': {
    'WARM': 3000,
    'NEUTRAL': 4000,
    'COOL': 6000
  }
}

LOGGER = logging.getLogger(__name__)

# -----------------------------------------------------------------------------


class Transmitter:
  # Transmitting binary waveform via code and sync_code.

  def __init__(self, gpio=17):
    self.gpio = gpio

  def transmit(self, pnum, code, sync_code='S', repeat=5):
    if not 0 <= pnum < len(PROTOCOLS):
      LOGGER.error("Unknown transmitter protocol: " + str(pnum))
      return False
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(self.gpio, GPIO.OUT)
    self._transmit_code(pnum, code)
    for r in range(repeat):
      self._transmit_code(pnum, sync_code)
      self._transmit_code(pnum, code)
    GPIO.cleanup()
    return True

  def _transmit_code(self, pnum, code):
    for c in code:
      if c == '0':
        self._transmit_waveform(
          PROTOCOLS[pnum].length, PROTOCOLS[pnum].zero_high, PROTOCOLS[pnum].zero_low)
      elif c == '1':
        self._transmit_waveform(
          PROTOCOLS[pnum].length, PROTOCOLS[pnum].one_high, PROTOCOLS[pnum].one_low)
      elif c == 'S':
        self._transmit_waveform(
          PROTOCOLS[pnum].length, PROTOCOLS[pnum].sync_high, PROTOCOLS[pnum].sync_low)
      else:
        LOGGER.warning("Unknown code: " + str(c))
        continue
    return True

  def _transmit_waveform(self, pulse_length, high_pulse, low_pulse):
    GPIO.output(args.gpio, GPIO.HIGH)
    self._sleep((high_pulse * pulse_length) / 1000000)
    GPIO.output(args.gpio, GPIO.LOW)
    self._sleep((low_pulse * pulse_length) / 1000000)
    return True

  def _sleep(self, delay):
    # make minimal sleep as 0.01s
    delay_internal = delay / 100
    end = time.time() + delay - delay_internal
    while time.time() < end:
      time.sleep(delay_internal)


class RecordKeeper:
  def __init__(self, host, db):
    self.influx_client = InfluxDBClient(host=host, port=8086, database=db)

  def tao95_obj(self, timestamp, power, main_power, main_brightness, main_color_temp, aux_power, aux_brightness, aux_color_temp):
    return {
      "measurement": "tao95",
      "time": timestamp,
      "fields": {
        "power": bool(power),
        "main_power": bool(main_power),
        "main_brightness": int(main_brightness),
        "main_color_temp": int(main_color_temp),
        "aux_power": bool(aux_power),
        "aux_brightness": int(aux_brightness),
        "aux_color_temp": int(aux_color_temp)
      }
    }

  def txone_obj(self, timestamp, power, brightness, color_temp, color_cycle):
    return {
      "measurement": "txone",
      "time": timestamp,
      "fields": {
        "power": bool(power),
        "brightness": int(brightness),
        "color_temp": int(color_temp),
        "color_cycle": bool(color_cycle)
      }
    }

  def get_tao95(self):
    query = 'SELECT * FROM "tao95" ORDER BY "time" DESC LIMIT 1;'
    result = self.influx_client.query(query, epoch='s')
    d = next(result.get_points('tao95'))
    re = d['time'], d['power'], d['main_power'], d['main_brightness'], d['main_color_temp'], d['aux_power'], d['aux_brightness'], d['aux_color_temp']
    LOGGER.debug("Get Tao95: %s", re)
    return re

  def save_tao95(self, power, main_power, main_brightness, main_color_temp, aux_power, aux_brightness, aux_color_temp):
    LOGGER.debug("Save Tao95: (%s, %s, %s, %s, %s, %s, %s)",
                 power, main_power, main_brightness, main_color_temp, aux_power, aux_brightness, aux_color_temp)
    ts = int(datetime.now().timestamp())
    obj = self.tao95_obj(ts, power, main_power, main_brightness,
                         main_color_temp, aux_power, aux_brightness, aux_color_temp)
    self.influx_client.write_points([obj], time_precision='s')
    return obj

  def get_txone(self):
    query = 'SELECT * FROM "txone" ORDER BY "time" DESC LIMIT 1;'
    result = self.influx_client.query(query, epoch='s')
    d = next(result.get_points('txone'))
    re = d['time'], d['power'], d['brightness'], d['color_temp'], d['color_cycle']
    LOGGER.debug("Get Txone: %s", re)
    return re

  def save_txone(self, power, brightness, color_temp, color_cycle):
    LOGGER.debug("Save Txone: (%s, %s, %s, %s)",
                 power, brightness, color_temp, color_cycle)
    ts = int(datetime.now().timestamp())
    obj = self.txone_obj(ts, power, brightness, color_temp, color_cycle)
    self.influx_client.write_points([obj], time_precision='s')
    return obj


class Tao95Light:
  # Tao95Light: set_light, click_button, sync.

  def __init__(self):
    self.last_update = None
    self.power = False
    self.main_power, self.main_brightness, self.main_color_temp = False, TAO95[
      'BRIGHTNESS']['FULL'], TAO95['COLOR_TEMPS']['WARM']
    self.aux_power, self.aux_brightness, self.aux_color_temp = False, TAO95[
      'BRIGHTNESS']['FULL'], TAO95['COLOR_TEMPS']['WARM']
    self.command_queue = []
    # device defaults
    self.btn_codes = self._to_raw_codes(
      TAO95['BTN_CODES'], TAO95['BTN_CODE_LEN'])
    # load the latest state from db
    self._load_db()

  def sync(self):
    # public: sync() reset db state to all-on-100%-3000k without any commands
    self.power = True
    self.main_power, self.main_brightness, self.main_color_temp = True, TAO95[
      'BRIGHTNESS']['FULL'], TAO95['COLOR_TEMPS']['WARM']
    self.aux_power, self.aux_brightness, self.aux_color_temp = True, TAO95[
      'BRIGHTNESS']['FULL'], TAO95['COLOR_TEMPS']['WARM']
    return self._update_db()

  def set_light(self, part, power, brightness=-1, color_temp=-1):
    # public: set_light(part='all'|'main'|'aux', power, brightness, color_temp)
    if brightness == 0 or brightness < -1:
      power = False
    if part == 'all':
      self._set_all(power, brightness, color_temp)
    elif part == 'main':
      self._set_main(power, brightness, color_temp)
    elif part == 'aux':
      self._set_aux(power, brightness, color_temp)
    else:
      LOGGER.error('Tao95Light, unknow part: ' + str(part))
      return False
    return self._execute_commands()

  def click_button(self, bnum, hold=False):
    # public: click_button(bnum, hold)
    self._add_command(bnum, hold)
    return self._execute_commands()

  def status(self):
    return RECORDKEEPER.tao95_obj(self.last_update, self.power,
                                  self.main_power, self.main_brightness, self.main_color_temp,
                                  self.aux_power, self.aux_brightness, self.aux_color_temp)

  def _to_raw_codes(self, int_codes, length):
    r = []
    for c in int_codes:
      r.append(format(c, '0{}b'.format(length)))
    return r

  def _add_command(self, bnum, hold=False):
    if not 0 <= bnum < len(self.btn_codes):
      LOGGER.error("Tao95, unknown btn: " + str(bnum))
      return False
    self.command_queue.append((bnum, hold))
    return True

  def _execute_commands(self):
    if not len(self.command_queue):
      return self.status()
    while len(self.command_queue):
      (bnum, hold) = self.command_queue.pop(0)
      self._transmit_command(bnum, hold)
      # leave delay after the last one for future commands
      time.sleep(TAO95['COMMAND_DELAY'])
    return self._update_db()

  def _transmit_command(self, bnum, hold):
    LOGGER.debug("Tao95, btn: %s, hold: %s", bnum, hold)
    TRANSMITTER.transmit(TAO95['PNUM'], self.btn_codes[bnum], TAO95['SYNC_CODE'], (
      TAO95['HOLD_REPEAT'] if hold else TAO95['DEFAULT_REPEAT']))
    return self._state_per_command(bnum, hold)

  def _state_per_command(self, bnum, hold):
    if bnum == 0:  # click the power btn, ignore hold
      if self.power:
        self.power, self.main_power, self.aux_power = False, False, False
      else:
        self.power, self.main_power, self.aux_power = True, True, True
    elif bnum == 1:  # click the main brightness btn
      if self.main_power:
        if hold:
          self.main_power = False
          if not self.aux_power:
            self.power = False
        else:
          self.main_brightness = self._next_brightness(self.main_brightness)
      else:
        self.power, self.main_power = True, True
    elif bnum == 2:  # click the main color_temp, ignore hold
      if self.main_power:
        self.main_color_temp = self._next_color_temp(self.main_color_temp)
    elif bnum == 3:  # click the aux brightness btn
      if self.aux_power:
        if hold:
          self.aux_power = False
          if not self.main_power:
            self.power = False
        else:
          self.aux_brightness = self._next_brightness(self.aux_brightness)
      else:
        self.power, self.aux_power = True, True
    elif bnum == 4:  # click the aux color_temp, ignore hold
      if self.aux_power:
        self.aux_color_temp = self._next_color_temp(self.aux_color_temp)
    return True

  def _next_brightness(self, brightness):
    s = self._brightness_to_step(brightness) + 1
    if s == 5:
      s = 1
    return self._step_to_brightness(s)

  def _next_color_temp(self, color_temp):
    s = self._color_temp_to_step(color_temp) + 1
    if s == 5:
      s = 1
    return self._step_to_color_temp(s)

  def _load_db(self):
    (self.last_update, self.power,
     self.main_power, self.main_brightness, self.main_color_temp,
     self.aux_power, self.aux_brightness, self.aux_color_temp) = RECORDKEEPER.get_tao95()
    return True

  def _update_db(self):
    return RECORDKEEPER.save_tao95(self.power,
                                   self.main_power, self.main_brightness, self.main_color_temp,
                                   self.aux_power, self.aux_brightness, self.aux_color_temp)

  def _set_all(self, power, brightness, color_temp):
    # if set power to on
    if power:
      if self.main_power:
        if not self.aux_power:  # if: main is on and aux is off
          self._add_command(3)   # then: turn on aux
      else:
        if self.aux_power:      # if: main is off and aux is on
          self._add_command(1)   # then: turn on main
        else:                   # if: both main and aux are off
          self._add_command(0)   # then: turn on all
      if brightness != -1:
        self._set_main_brightness(brightness)
        self._set_aux_brightness(brightness)
      if color_temp != -1:
        self._set_main_color_temp(color_temp)
        self._set_aux_color_temp(color_temp)
    # if set all to off, ignore brightness and color_temp
    else:
      if self.main_power or self.aux_power:  # if: either main or aux is on
        self._add_command(0)                  # then: turn off all
    return True

  def _set_main(self, power, brightness, color_temp):
    # if set main to on
    if power:
      if not self.main_power:
        self._add_command(1)
      if brightness != -1:
        self._set_main_brightness(brightness)
      if color_temp != -1:
        self._set_main_color_temp(color_temp)
    # if set main to off, ignore brightness and color_temp
    else:
      if self.main_power:
        if self.aux_power:           # if: both main and aux is on
          self._add_command(1, True)  # then: turn off main only
        else:                        # if: main is on and aux is off
          self._add_command(0)        # then: turn off main via all
    return True

  def _set_aux(self, power, brightness, color_temp):
    # if set aux to on
    if power:
      if not self.aux_power:
        self._add_command(3)
      if brightness != -1:
        self._set_aux_brightness(brightness)
      if color_temp != -1:
        self._set_aux_color_temp(color_temp)
    # if set aux to off, ignore brightness and color_temp
    else:
      if self.aux_power:
        if self.main_power:          # if: both aux and main is on
          self._add_command(3, True)  # then: turn off a only
        else:                        # if: aux is on and main is off
          self._add_command(0)        # then: turn off aux via all
    return True

  def _set_main_brightness(self, brightness):
    for i in range((self._brightness_to_step(brightness) - self._brightness_to_step(self.main_brightness)) % 4):
      self._add_command(1)
    return True

  def _set_main_color_temp(self, color_temp):
    for i in range((self._color_temp_to_step(color_temp) - self._color_temp_to_step(self.main_color_temp)) % 4):
      self._add_command(2)
    return True

  def _set_aux_brightness(self, brightness):
    for i in range((self._brightness_to_step(brightness) - self._brightness_to_step(self.aux_brightness)) % 4):
      self._add_command(3)
    return True

  def _set_aux_color_temp(self, color_temp):
    for i in range((self._color_temp_to_step(color_temp) - self._color_temp_to_step(self.aux_color_temp)) % 4):
      self._add_command(4)
    return True

  def _brightness_to_step(self, brightness):
    # trun brightness from 0-100 into step 1-4
    # brightness 0 should be ignored as 1 and not saved
    if brightness < (TAO95['BRIGHTNESS']['MED'] + TAO95['BRIGHTNESS']['LOW']) / 2:
      return 1
    elif brightness >= (TAO95['BRIGHTNESS']['MED'] + TAO95['BRIGHTNESS']['LOW']) / 2 and brightness < (TAO95['BRIGHTNESS']['MED'] + TAO95['BRIGHTNESS']['HIGH']) / 2:
      return 2
    elif brightness >= (TAO95['BRIGHTNESS']['MED'] + TAO95['BRIGHTNESS']['HIGH']) / 2 and brightness < (TAO95['BRIGHTNESS']['FULL'] + TAO95['BRIGHTNESS']['HIGH']) / 2:
      return 3
    elif brightness >= (TAO95['BRIGHTNESS']['FULL'] + TAO95['BRIGHTNESS']['HIGH']) / 2:
      return 4

  def _color_temp_to_step(self, color_temp):
    # trun color_temp from 3k, 4k, 5k, 6k into step 1-4
    if color_temp >= (TAO95['COLOR_TEMPS']['COOL'] + TAO95['COLOR_TEMPS']['COOLER']) / 2:
      # COOL
      return 4
    elif color_temp >= (TAO95['COLOR_TEMPS']['NEUTRAL'] + TAO95['COLOR_TEMPS']['COOLER']) / 2 and color_temp < (TAO95['COLOR_TEMPS']['COOL'] + TAO95['COLOR_TEMPS']['COOLER']) / 2:
      # COOLER
      return 3
    elif color_temp >= (TAO95['COLOR_TEMPS']['NEUTRAL'] + TAO95['COLOR_TEMPS']['WARM']) / 2 and color_temp < (TAO95['COLOR_TEMPS']['NEUTRAL'] + TAO95['COLOR_TEMPS']['COOLER']) / 2:
      # NEUTRAL
      return 2
    else:
      # WARM
      return 1

  def _step_to_color_temp(self, color_temp_step):
    if color_temp_step == 4:
      return TAO95['COLOR_TEMPS']['COOL']
    elif color_temp_step == 3:
      return TAO95['COLOR_TEMPS']['COOLER']
    elif color_temp_step == 2:
      return TAO95['COLOR_TEMPS']['NEUTRAL']
    else:
      return TAO95['COLOR_TEMPS']['WARM']

  def _step_to_brightness(self, brightness_step):
    return brightness_step * 25


class TxoneLight:
  # TxoneLight: set_light, click_button, sync.

  def __init__(self):
    self.last_update = None
    self.power, self.brightness, self.color_temp, self.color_cycle = False, 100, TXONE[
      'COLOR_TEMPS']['WARM'], False
    self.command_queue = []
    # device defaults
    self.btn_codes = self._to_raw_codes(
      TXONE['BTN_CODES'], TXONE['BTN_CODE_LEN'])
    # load the latest state from db
    self._load_db()

  def sync(self):
    # public: sync() reset db state to ON 3000k@100% via warm shortcut without any commands
    self.power, self.brightness, self.color_temp, self.color_cycle = True, 100, TXONE[
      'COLOR_TEMPS']['WARM'], False
    return self._update_db()

  def set_light(self, power, brightness, color_temp):
    # public: set_light(power, brightness, color_temp)
    if brightness == 0 or brightness < -1:
      power = False
    brightness = self._clean_bn(brightness)
    color_temp = self._clean_ct(color_temp)
    if power:
      if not self.power:
        # turn on light now
        self._add_command(0, TXONE['POWER_REPEAT'])
      if (color_temp != self.color_temp or brightness != self.brightness):
        if brightness == 100:
          self._ct100_command(color_temp)
        else:
          self._set_light(brightness, color_temp)
    else:
      if self.power:
        self._add_command(1, TXONE['POWER_REPEAT'])  # turn off light now
    return self._execute_commands()

  def click_button(self, bnum):
    self._add_command(bnum, TXONE['POWER_REPEAT'] if (
      bnum == 0 or bnum == 1) else TXONE['DEFAULT_REPEAT'])
    return self._execute_commands()

  def status(self):
    return RECORDKEEPER.txone_obj(self.last_update, self.power,
                                  self.brightness, self.color_temp, self.color_cycle)

  def _set_light(self, brightness, color_temp):
    if color_temp == self.color_temp:
      self._set_brightness(self.brightness, brightness, color_temp)
      return True
    else:
      self._set_color_temp(color_temp)
      self._set_brightness(10, brightness, color_temp)
      return True

  def _set_color_temp(self, target):
    if self.color_cycle:  # currently in the color cycle
      ct = self.color_temp
      while(ct != target):
        self._add_command(4)  # cycle 4K->6K->3K->4K
        ct = self._get_next_color_temp(ct)
    else:  # currently not in the color cycle
      self._add_command(4)  # change to 4k@10%
      if target == TXONE['COLOR_TEMPS']['COOL']:
        self._add_command(4)
      elif target == TXONE['COLOR_TEMPS']['WARM']:
        self._add_command(4)
        self._add_command(4)
    return True

  def _get_next_color_temp(self, current):
    # cycle 4K(N)->6K(C)->3K(W)->4K(N)
    if current == TXONE['COLOR_TEMPS']['NEUTRAL']:
      return TXONE['COLOR_TEMPS']['COOL']
    elif current == TXONE['COLOR_TEMPS']['COOL']:
      return TXONE['COLOR_TEMPS']['WARM']
    else:
      return TXONE['COLOR_TEMPS']['NEUTRAL']

  def _get_brightness_tier(self, brightness, color_temp):
    if color_temp == TXONE['COLOR_TEMPS']['NEUTRAL']:
      return 2
    else:
      if brightness == 10:
        return 1
      elif brightness == 100:
        return 0
      else:
        for tier in range(len(TXONE['BRIGHTNESS_TIER'])):
          if brightness in TXONE['BRIGHTNESS_TIER'][tier]:
            return tier

  def _set_brightness(self, current, target, color_temp):
    # change brightness from current (10-100) to target (10-99)
    if current == target:
      return True
    tier = self._get_brightness_tier(current, color_temp)
    return self._add_birghtness_command(current, target, tier)

  def _add_birghtness_command(self, current, target, tier):
    # B+ is 2, B- is 3
    command = 2 if (current - target) < 0 else 3
    l = TXONE['BRIGHTNESS_TIER'][tier]
    ci = self._find_closest_index(l, current)
    ti = self._find_closest_index(l, target)
    if ci == ti:
      return True
    else:
      # 3 is the repeat interval between each step
      return self._add_command(command, 3 * abs(ti - ci))

  def _find_closest_index(self, arr, val):
    # find the closest value in arr to val
    if len(arr) == 0:
      return -1
    if val in arr:
      return arr.index(val)
    else:
      for x in range(len(arr)):
        if val < arr[x] + 5:
          return x

  def _ct100_command(self, color_temp):
    # convert color_temp @100 to btn code
    if color_temp > (TXONE['COLOR_TEMPS']['COOL'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2:
      return self._add_command(7)
    elif color_temp <= (TXONE['COLOR_TEMPS']['COOL'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2 and color_temp > (TXONE['COLOR_TEMPS']['WARM'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2:
      return self._add_command(6)
    else:
      return self._add_command(5)

  def _clean_bn(self, brightness):
    if brightness == -1:
      return self.brightness
    elif brightness <= 10:
      return 10
    elif brightness >= 100:
      return 100
    else:
      return brightness

  def _clean_ct(self, color_temp):
    if color_temp == -1:
      return self.color_temp
    elif color_temp > (TXONE['COLOR_TEMPS']['COOL'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2:
      return TXONE['COLOR_TEMPS']['COOL']
    elif color_temp <= (TXONE['COLOR_TEMPS']['COOL'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2 and color_temp > (TXONE['COLOR_TEMPS']['WARM'] + TXONE['COLOR_TEMPS']['NEUTRAL']) / 2:
      return TXONE['COLOR_TEMPS']['NEUTRAL']
    else:
      return TXONE['COLOR_TEMPS']['WARM']

  def _to_raw_codes(self, int_codes, length):
    r = []
    for c in int_codes:
      r.append(format(c, '0{}b'.format(length)))
    return r

  def _add_command(self, bnum, repeat=TXONE['DEFAULT_REPEAT']):
    if not 0 <= bnum < len(self.btn_codes):
      LOGGER.error("Txone, unknown btn: " + str(bnum))
      return False
    self.command_queue.append((bnum, repeat))
    return True

  def _execute_commands(self):
    if not len(self.command_queue):
      return self.status()
    while len(self.command_queue):
      (bnum, repeat) = self.command_queue.pop(0)
      self._transmit_command(bnum, repeat)
      # leave delay after the last one for future commands
      time.sleep(TXONE['COMMAND_DELAY'])
    return self._update_db()

  def _transmit_command(self, bnum, repeat):
    LOGGER.debug("Txone, btn: %s, repeat: %s", bnum, repeat)
    TRANSMITTER.transmit(
      TXONE['PNUM'], self.btn_codes[bnum], TXONE['SYNC_CODE'], repeat)
    return self._state_per_command(bnum, repeat)

  def _state_per_command(self, bnum, repeat):
    if bnum == 0:    # power on
      self.power = True
      return True
    elif bnum == 1:  # power off
      self.power = False
      return True
    elif bnum == 2:  # brightness +
      if self.power:
        t = self._get_brightness_tier(self.brightness, self.color_temp)
        ci = self._find_closest_index(
          TXONE['BRIGHTNESS_TIER'][t], self.brightness)
        ni = ci + int(repeat / 3)
        if ni >= len(TXONE['BRIGHTNESS_TIER'][t]):
          self.brightness = 100
        else:
          self.brightness = TXONE['BRIGHTNESS_TIER'][t][ni]
      return True
    elif bnum == 3:  # brightness -
      if self.power:
        t = self._get_brightness_tier(self.brightness, self.color_temp)
        ci = self._find_closest_index(
          TXONE['BRIGHTNESS_TIER'][t], self.brightness)
        ni = ci - int(repeat / 3)
        if ni < 0:
          self.brightness = 10
        else:
          self.brightness = TXONE['BRIGHTNESS_TIER'][t][ni]
      return True
    elif bnum == 4:  # Cycle @ 10, cycle 4K->6K->3K->4K
      if self.power:
        self.brightness = 10
        if self.color_cycle:
          self.color_temp = self._get_next_color_temp(self.color_temp)
        else:
          self.color_cycle = True
          self.color_temp = TXONE['COLOR_TEMPS']['NEUTRAL']
      return True
    elif bnum == 5:  # 3K @ 100
      if self.power:
        self.brightness = 100
        self.color_temp = TXONE['COLOR_TEMPS']['WARM']
        self.color_cycle = False
      return True
    elif bnum == 6:  # 4K @ 100
      if self.power:
        self.brightness = 100
        self.color_temp = TXONE['COLOR_TEMPS']['NEUTRAL']
        self.color_cycle = False
      return True
    elif bnum == 7:  # 6K @ 100
      if self.power:
        self.brightness = 100
        self.color_temp = TXONE['COLOR_TEMPS']['COOL']
        self.color_cycle = False
      return True
    return True

  def _load_db(self):
    (self.last_update, self.power, self.brightness, self.color_temp,
     self.color_cycle) = RECORDKEEPER.get_txone()
    return True

  def _update_db(self):
    return RECORDKEEPER.save_txone(self.power, self.brightness, self.color_temp, self.color_cycle)


# -----------------------------------------------------------------------------

def exithandler(signal, frame):
  GPIO.cleanup()
  sys.exit(0)


start = time.time()

parser = argparse.ArgumentParser(description='Control stateless rf lights')
parser.add_argument('--gpio', type=int, default=17)
parser.add_argument('--influx', default='localhost')
parser.add_argument('--database', default='rf')
parser.add_argument('--light', help='txone or tao95')
parser.add_argument('--on', action='store_true')
parser.add_argument('--off', dest='power', action='store_false')
parser.set_defaults(power=True)
parser.add_argument('--part', help='tao95: all, main, or aux', default='all')
parser.add_argument('--brightness', type=int, default=-1)
parser.add_argument('--colortemp', type=int, default=-1)
parser.add_argument('--button', type=int, help='click button')
parser.add_argument('--hold', action='store_true')
parser.set_defaults(hold=False)
parser.add_argument('--sync', action='store_true')
parser.add_argument('--status', action='store_true')

args = parser.parse_args()

logging.basicConfig(level=logging.CRITICAL, datefmt='%Y-%m-%d %H:%M:%S',
                    format='%(asctime)-15s - [%(levelname)s] %(module)s: %(message)s')
TRANSMITTER = Transmitter()
RECORDKEEPER = RecordKeeper(args.influx, args.database)

signal.signal(signal.SIGINT, exithandler)


re = {}

if args.light == 'tao95':
  tao = Tao95Light()
  if args.button is not None:
    re = tao.click_button(args.button, args.hold)
  elif args.sync:
    re = tao.sync()
  elif args.status:
    re = tao.status()
  else:
    re = tao.set_light(args.part, args.power, args.brightness, args.colortemp)
if args.light == 'txone':
  tx = TxoneLight()
  if args.button is not None:
    re = tx.click_button(args.button)
  elif args.sync:
    re = tx.sync()
  elif args.status:
    re = tx.status()
  else:
    re = tx.set_light(args.power, args.brightness, args.colortemp)

sys.stdout.write(json.dumps(re))

LOGGER.debug("Time: %s", time.time() - start)
