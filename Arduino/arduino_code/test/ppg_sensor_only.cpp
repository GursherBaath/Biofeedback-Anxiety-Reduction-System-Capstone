#include <Arduino.h>

// Pin Definitions (Arduino Nano ESP32)
const int PULSE_SENSOR_PIN = A0;  // Analog input pin for the pulse sensor
const int LED13 = LED_BUILTIN;    // On-board Arduino LED

// PulseSensor Variables
int Signal;                     // holds the incoming raw data. Signal value can range from 0-4095 on ESP32
int Threshold = 700;            // Determine which Signal to "count as a beat", and which to ignore
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
  Serial.begin(115200);
  setupPulseSensor();
  setupTimer100Hz();
}

void loop() {
  readPulseSensor();
}

// ========== PULSESENSOR FUNCTIONS ==========

void setupPulseSensor() {
  pinMode(LED13, OUTPUT);  // pin that will blink to your heartbeat!
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

  int s;
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
    Serial.println(Signal); // Output only the signal
  }
}