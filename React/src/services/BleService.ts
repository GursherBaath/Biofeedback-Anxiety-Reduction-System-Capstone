import {BleManager, ConnectionPriority, Device, Subscription} from 'react-native-ble-plx';
import {PermissionsAndroid, Platform} from 'react-native';

// Hermes provides atob/btoa globally but TS may not have declarations
declare function atob(data: string): string;

const DEVICE_NAME = 'NanoESP32_PPG';
const SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
const TX_CHAR_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

export type PPGCallback = (samples: number[]) => void;

class BleService {
  private manager: BleManager;
  private device: Device | null = null;
  private subscription: Subscription | null = null;
  private onData: PPGCallback | null = null;
  private onStatusChange: ((status: string) => void) | null = null;
  private _connected = false;
  private additionalDataListeners: Map<string, PPGCallback> = new Map();
  private additionalStatusListeners: Map<string, (status: string) => void> = new Map();

  constructor() {
    this.manager = new BleManager();
  }

  get connected(): boolean {
    return this._connected;
  }

  setOnData(cb: PPGCallback) {
    this.onData = cb;
  }

  setOnStatusChange(cb: (status: string) => void) {
    this.onStatusChange = cb;
  }

  addOnData(id: string, cb: PPGCallback) {
    this.additionalDataListeners.set(id, cb);
  }

  removeOnData(id: string) {
    this.additionalDataListeners.delete(id);
  }

  addOnStatusChange(id: string, cb: (status: string) => void) {
    this.additionalStatusListeners.set(id, cb);
  }

  removeOnStatusChange(id: string) {
    this.additionalStatusListeners.delete(id);
  }

  private emitStatus(status: string) {
    this.onStatusChange?.(status);
    this.additionalStatusListeners.forEach(cb => cb(status));
  }

  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      return true;
    }
    const apiLevel = Platform.Version;
    if (apiLevel >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return Object.values(results).every(
        r => r === PermissionsAndroid.RESULTS.GRANTED,
      );
    } else {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
  }

  async scanAndConnect(): Promise<void> {
    const granted = await this.requestPermissions();
    if (!granted) {
      this.emitStatus('Permissions denied');
      return;
    }

    this.emitStatus('Scanning...');

    return new Promise<void>((resolve, reject) => {
      this.manager.startDeviceScan(
        [SERVICE_UUID],
        {allowDuplicates: false},
        async (error, scannedDevice) => {
          if (error) {
            this.emitStatus(`Scan error: ${error.message}`);
            reject(error);
            return;
          }

          if (
            scannedDevice &&
            (scannedDevice.name === DEVICE_NAME ||
              scannedDevice.localName === DEVICE_NAME)
          ) {
            this.manager.stopDeviceScan();
            this.emitStatus(`Found ${DEVICE_NAME}. Connecting...`);

            try {
              await this.connectToDevice(scannedDevice);
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        },
      );

      // Timeout after 15 seconds
      setTimeout(() => {
        this.manager.stopDeviceScan();
        if (!this._connected) {
          this.emitStatus('Scan timeout. Device not found.');
          reject(new Error('Scan timeout'));
        }
      }, 15000);
    });
  }

  private async connectToDevice(scannedDevice: Device): Promise<void> {
    try {
      const connectedDevice = await scannedDevice.connect({
        requestMTU: 185,
      });

      this.device = connectedDevice;

      await connectedDevice.discoverAllServicesAndCharacteristics();

      // Request high connection priority for low BLE latency
      await connectedDevice.requestConnectionPriority(
        ConnectionPriority.High,
      );

      this._connected = true;
      this.emitStatus('Connected. Streaming...');

      // Monitor for disconnection
      this.manager.onDeviceDisconnected(
        connectedDevice.id,
        (_error, _device) => {
          this._connected = false;
          this.emitStatus('Disconnected');
          this.subscription?.remove();
          this.subscription = null;
          this.device = null;
        },
      );

      // Subscribe to PPG notifications
      this.subscription = connectedDevice.monitorCharacteristicForService(
        SERVICE_UUID,
        TX_CHAR_UUID,
        (error, characteristic) => {
          if (error) {
            console.warn('[BLE] Notification error:', error.message);
            return;
          }
          if (characteristic?.value) {
            this.parseAndEmit(characteristic.value);
          }
        },
      );
    } catch (error: any) {
      this._connected = false;
      this.emitStatus(`Connection failed: ${error.message}`);
      throw error;
    }
  }

  private parseAndEmit(base64Value: string): void {
    try {
      // Decode base64 to string
      const raw = atob(base64Value);
      console.log('[BLE] Raw data:', JSON.stringify(raw));
      // The Arduino sends "val1,val2,val3,val4\n" — may contain multiple lines
      const lines = raw.trim().split('\n');
      const samples: number[] = [];
      for (const line of lines) {
        const parts = line.trim().split(',');
        for (const part of parts) {
          const val = parseInt(part, 10);
          if (!isNaN(val)) {
            samples.push(val);
          }
        }
      }
      if (samples.length > 0) {
        this.onData?.(samples);
        this.additionalDataListeners.forEach(cb => cb(samples));
      }
    } catch (e: any) {
      console.warn('[BLE] Parse error:', e.message, 'input:', base64Value);
    }
  }

  async disconnect(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch (_) {
        // Already disconnected
      }
      this.device = null;
    }
    this._connected = false;
    this.emitStatus('Disconnected');
  }

  destroy() {
    this.disconnect();
    this.manager.destroy();
  }
}

// Singleton instance
export const bleService = new BleService();
