import { spawn } from 'child_process';
import path from 'path';

interface LightState {
  On: boolean;
  Brightness: number;
}

type Command = {
  type: 'remote' | 'control';
  args: string[];
};

export class RecordKeeper {
  private states: Record<string, LightState> = {};
  private commandQueue: Command[] = [];
  private isProcessing = false;
  private controlPy: string;
  private remotePy: string;

  constructor(scriptDir: string) {
    this.controlPy = path.join(scriptDir + 'control.py');
    this.remotePy = path.join(scriptDir + 'remote.py');
  }

  public async initState(light: string) {
    this.queueCommand('control', ['--light', light, '--status']);
  }

  public getState(id: string): LightState {
    return this.states[id];
  }

  public async remote(light: string, button: string) {
    this.queueCommand('remote', ['--light', light, '--button', button]);
  }

  public async sync(light: string) {
    this.queueCommand('control', ['--light', light, '--sync']);
  }

  public async controlPower(id: string, value: boolean, light: string, commands: string[]) {
    this.states[id].On = value;
    this.queueCommand('control', ['--light', light, ...commands]);
  }

  public async controlBrightness(id: string, value: number, light: string, commands: string[]) {
    this.states[id].Brightness = value;
    this.queueCommand('control', ['--light', light, ...commands]);
  }

  private queueCommand(type: 'remote' | 'control', args: string[]) {
    this.commandQueue.push({ type, args });
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue() {
    this.isProcessing = true;

    while (this.commandQueue.length > 0) {
      const { type, args } = this.commandQueue.shift()!;
      try {
        await this.runPythonScript(type, args);
      } catch (error) {
        console.error('Error processing command:', error);
      }
    }

    this.isProcessing = false;
  }

  private saveResults(data: any) {
    const { light, power, brightness, parts } = data;

    this.states[`${light}-default`] = { On: power, Brightness: brightness };
    parts?.forEach((part: any) => {
      this.states[`${light}-${part.partName}`] = {
        On: part.power,
        Brightness: part.brightness
      };
    });
  }

  private runPythonScript(type: 'remote' | 'control', args: string[]) {
    const script = type === 'remote' ? this.remotePy : this.controlPy;

    return new Promise<void>((resolve, reject) => {
      const pythonProcess = spawn('/usr/bin/python3', [script, ...args]);
      let output = '';

      // console.debug('runPythonScript', [script, ...args]);

      pythonProcess.stdout.on('data', (data) => (output += data.toString()));
      pythonProcess.stderr.on('data', (data) => console.error(`stderr: ${data}`));
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Python script exited with code ${code}`));
        }

        if (output) {
          try {
            this.saveResults(JSON.parse(output.trim()));
            resolve();
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error}`));
          }
        } else {
          resolve();
        }
      });
    });
  }
}
