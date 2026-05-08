#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Pin Definitions (Arduino Nano ESP32)
const int PULSE_SENSOR_PIN = A0;  // Analog input pin for the pulse sensor
const int LED13 = LED_BUILTIN;    // On-board Arduino LED

// BLE settings
const char *BLE_DEVICE_NAME = "NanoESP32_PPG";
const char *SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const char *TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"; // Notify characteristic

BLEServer *bleServer = nullptr;
BLECharacteristic *txCharacteristic = nullptr;
bool bleClientConnected = false;

// PulseSensor Variables
int Signal;
int Threshold = 700;
int count = 0;

// Sampling buffer for timer -> loop handoff
const uint8_t SAMPLE_BUFFER_SIZE = 64;
volatile int sampleBuffer[SAMPLE_BUFFER_SIZE];
volatile uint8_t sampleHead = 0;
volatile uint8_t sampleTail = 0;

// Timer flag (set in ISR, handled in loop)
volatile bool sampleFlag = false;
portMUX_TYPE sampleMux = portMUX_INITIALIZER_UNLOCKED;
hw_timer_t *sampleTimer = nullptr;

// Function Prototypes
void setupPulseSensor();
void readPulseSensor();
void setupTimer100Hz();

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    bleClientConnected = true;
  }

  void onDisconnect(BLEServer *pServer) override {
    bleClientConnected = false;
    BLEDevice::startAdvertising();
  }
};

// Timer ISR: just set a flag (keep ISR short)
void IRAM_ATTR onSampleTimer() {
  portENTER_CRITICAL_ISR(&sampleMux);
  sampleFlag = true;
  portEXIT_CRITICAL_ISR(&sampleMux);
}

void setupTimer100Hz() {
  // 80 MHz / 80 = 1 MHz timer tick -> 1 tick = 1 us
  sampleTimer = timerBegin(0, 80, true);
  timerAttachInterrupt(sampleTimer, &onSampleTimer, true);
  // 100 Hz = 10,000 us
  timerAlarmWrite(sampleTimer, 10000, true);
  timerAlarmEnable(sampleTimer);
}

void setup() {
  setupPulseSensor();
  setupTimer100Hz();

  BLEDevice::init(BLE_DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService *service = bleServer->createService(SERVICE_UUID);

  txCharacteristic = service->createCharacteristic(
    TX_CHAR_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  txCharacteristic->addDescriptor(new BLE2902());

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void loop() {
  readPulseSensor();
}

// ========== PULSESENSOR FUNCTIONS ==========

void setupPulseSensor() {
  pinMode(LED13, OUTPUT);
}

void readPulseSensor() {
  bool doSample = false;

  portENTER_CRITICAL(&sampleMux);
  if (sampleFlag) {
    sampleFlag = false;
    doSample = true;
  }
  portEXIT_CRITICAL(&sampleMux);

  if (doSample) {
    int s = analogRead(PULSE_SENSOR_PIN);
    uint8_t nextHead = (sampleHead + 1) % SAMPLE_BUFFER_SIZE;
    if (nextHead != sampleTail) {
      sampleBuffer[sampleHead] = s;
      sampleHead = nextHead;
    }
  }

  int s = 0;
  bool hasSample = false;

  portENTER_CRITICAL(&sampleMux);
  if (sampleTail != sampleHead) {
    s = sampleBuffer[sampleTail];
    sampleTail = (sampleTail + 1) % SAMPLE_BUFFER_SIZE;
    hasSample = true;
  }
  portEXIT_CRITICAL(&sampleMux);

  if (hasSample) {
    Signal = s;

    if (bleClientConnected && txCharacteristic != nullptr) {
      char out[12];
      int len = snprintf(out, sizeof(out), "%d\n", Signal);
      txCharacteristic->setValue((uint8_t *)out, len);
      txCharacteristic->notify();
    }
  }
}
