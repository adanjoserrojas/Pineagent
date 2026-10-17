// PlantBotTest — component test firmware for the SwampHacks plant companion.
//
// Talks plain text over the native USB port (115200 baud setting is ignored by USB CDC).
// Every command gets exactly one reply line that starts with "OK " or "ERR ".
// Pair it with PlantBot-TestBench.html (Chrome or Edge, Web Serial).
//
// Pin map matches the Plant Bot Wiring Map.
//   Display (ST7789 170x320): SCL=12  SDA=11  CS=10  DC=9  RES=14  BLK=21  VCC=3V3
//   Amp (MAX98357A, I2S):     BCLK=4  LRC=5  DIN=6
//   Servos:                   L=15  R=16   (powered from the brick, not the ESP32)
//   Piezo:                    17
//   5 V sense divider:        7    (10k top / 20k bottom -> ~3.3 V when the brick is on)
//   On-board RGB LED:         48 by default (some boards use 38; change with "LED PIN 38")

#include <Arduino.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <ESP_I2S.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>

// ---------- pins ----------
const int PIN_TFT_SCK = 12, PIN_TFT_MOSI = 11, PIN_TFT_CS = 10, PIN_TFT_DC = 9, PIN_TFT_RST = 14, PIN_TFT_BL = 21;
const int PIN_I2S_BCLK = 4, PIN_I2S_LRC = 5, PIN_I2S_DIN = 6;
const int PIN_SERVO_L = 15, PIN_SERVO_R = 16;
const int PIN_PIEZO = 17;
const int PIN_SENSE = 7;
int pinLed = 48;

// ---------- LEDC channels (channels 2n and 2n+1 share a timer) ----------
const int CH_SERVO_L = 0, CH_SERVO_R = 1;  // timer 0 @ 50 Hz
const int CH_PIEZO = 2;                   // timer 1, retuned for each tone
const int CH_BL = 4;                      // timer 2 @ 5 kHz

// ---------- servo settings ----------
const int SERVO_MIN_DEG = 20, SERVO_MAX_DEG = 160;   // stay off the end stops
const int SERVO_US_0 = 500, SERVO_US_180 = 2400;     // SG90 / SG92R pulse range
const int SERVO_BITS = 14;

// ---------- audio ----------
const uint32_t SAMPLE_RATE = 24000;
I2SClass i2s;
bool i2sReady = false;

// ---------- display ----------
Adafruit_ST7789 tft(&SPI, PIN_TFT_CS, PIN_TFT_DC, PIN_TFT_RST);
bool tftReady = false;

// ---------- state ----------
bool gate = true;            // refuse servo/amp commands when the brick isn't detected
bool servoAttached[2] = {false, false};
String line;

// ======================================================================
// helpers
// ======================================================================
void ok(const String &s)  { Serial.print("OK ");  Serial.println(s); }
void err(const String &s) { Serial.print("ERR "); Serial.println(s); }

uint32_t senseMilliVolts() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(PIN_SENSE);
  return sum / 8;
}
bool brickOn() { return senseMilliVolts() > 2500; }

bool needPower(const char *what) {
  if (!gate || brickOn()) return true;
  err(String(what) + " needs the 5 V brick plugged in (SENSE reads low). Plug it in, or send GATE 0 to override.");
  return false;
}

String hexColorName(uint16_t c) { char b[8]; snprintf(b, sizeof b, "0x%04X", c); return String(b); }
uint16_t rgb565(int r, int g, int b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }

// ======================================================================
// servos
// ======================================================================
uint32_t degToDuty(int deg) {
  long us = SERVO_US_0 + (long)(SERVO_US_180 - SERVO_US_0) * deg / 180;
  return (uint32_t)(us * ((1UL << SERVO_BITS) - 1) / 20000UL);
}
void servoWrite(int idx, int deg) {
  int pin = idx == 0 ? PIN_SERVO_L : PIN_SERVO_R;
  int ch  = idx == 0 ? CH_SERVO_L : CH_SERVO_R;
  if (!servoAttached[idx]) { ledcAttachChannel(pin, 50, SERVO_BITS, ch); servoAttached[idx] = true; }
  ledcWrite(pin, degToDuty(deg));
}
void servoRelease(int idx) {
  int pin = idx == 0 ? PIN_SERVO_L : PIN_SERVO_R;
  if (servoAttached[idx]) { ledcWrite(pin, 0); ledcDetach(pin); servoAttached[idx] = false; }
  pinMode(pin, OUTPUT); digitalWrite(pin, LOW);
}

// ======================================================================
// audio
// ======================================================================
bool audioBegin() {
  if (i2sReady) return true;
  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_LRC, PIN_I2S_DIN);
  // Stereo frames with the same sample in both slots: the MAX98357A outputs (L+R)/2 by default.
  i2sReady = i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  return i2sReady;
}

// Writes a sine (or a linear sweep when f1 != f0) with short fades to avoid clicks.
void playTone(float f0, float f1, uint32_t ms, int volPct) {
  const int N = 256;
  int16_t buf[N * 2];
  uint32_t total = SAMPLE_RATE * ms / 1000, fade = SAMPLE_RATE / 100; // 10 ms fades
  float amp = 32767.0f * constrain(volPct, 0, 100) / 100.0f, phase = 0;
  for (uint32_t i = 0; i < total;) {
    int n = min<uint32_t>(N, total - i);
    for (int k = 0; k < n; k++, i++) {
      float f = f0 + (f1 - f0) * (float)i / total;
      phase += 2.0f * PI * f / SAMPLE_RATE;
      if (phase > 2.0f * PI) phase -= 2.0f * PI;
      float env = 1.0f;
      if (i < fade) env = (float)i / fade;
      else if (total - i < fade) env = (float)(total - i) / fade;
      int16_t s = (int16_t)(sinf(phase) * amp * env);
      buf[2 * k] = s; buf[2 * k + 1] = s;
    }
    i2s.write((uint8_t *)buf, n * 4);
  }
  memset(buf, 0, sizeof buf);
  i2s.write((uint8_t *)buf, sizeof buf); // flush with silence
}

// ======================================================================
// display
// ======================================================================
bool displayBegin() {
  if (tftReady) return true;
  SPI.begin(PIN_TFT_SCK, -1, PIN_TFT_MOSI, PIN_TFT_CS);
  tft.init(170, 320);           // the library applies the 35-pixel column offset for 170x320 panels
  tft.setSPISpeed(40000000);
  tft.setRotation(1);           // landscape, 320 x 170
  tftReady = true;
  return true;
}
void backlight(int level) {
  static bool attached = false;
  if (!attached) { ledcAttachChannel(PIN_TFT_BL, 5000, 8, CH_BL); attached = true; }
  ledcWrite(PIN_TFT_BL, constrain(level, 0, 255));
}
void drawFace(bool happy) {
  int w = tft.width(), h = tft.height();
  tft.fillScreen(rgb565(16, 40, 24));
  uint16_t ink = rgb565(232, 245, 230);
  int ex = w / 2 - 60, ey = h / 2 - 20;
  tft.fillRoundRect(ex - 14, ey - 22, 28, 44, 12, ink);
  tft.fillRoundRect(ex + 120 - 14, ey - 22, 28, 44, 12, ink);
  int cx = w / 2, cy = h / 2 + 30;
  for (int a = 20; a <= 160; a += 2) {
    float r = a * PI / 180.0f;
    int x = cx + cosf(r) * 40, y = happy ? cy + sinf(r) * 18 : cy + 18 - sinf(r) * 18;
    tft.fillCircle(x, y, 3, ink);
  }
}
void drawPattern() {
  int w = tft.width(), h = tft.height();
  const uint16_t bars[] = { ST77XX_WHITE, ST77XX_YELLOW, ST77XX_CYAN, ST77XX_GREEN, ST77XX_MAGENTA, ST77XX_RED, ST77XX_BLUE, ST77XX_BLACK };
  for (int i = 0; i < 8; i++) tft.fillRect(i * w / 8, 0, w / 8 + 1, h, bars[i]);
  tft.drawRect(0, 0, w, h, ST77XX_RED);           // a red frame on all 4 edges = offset is right
  tft.drawRect(1, 1, w - 2, h - 2, ST77XX_RED);
  tft.setTextColor(ST77XX_BLACK, ST77XX_WHITE);
  tft.setTextSize(2); tft.setCursor(8, 8); tft.print("PLANT BOT");
  tft.setTextSize(1); tft.setCursor(8, h - 14); tft.print("320x170  red frame should touch every edge");
}

// ======================================================================
// commands
// ======================================================================
void cmdInfo() {
  uint32_t mv = senseMilliVolts();
  String s = "INFO chip=" + String(ESP.getChipModel()) + " rev=" + String(ESP.getChipRevision()) +
             " cores=" + String(ESP.getChipCores()) + " cpu_mhz=" + String(ESP.getCpuFreqMHz()) +
             " flash_mb=" + String(ESP.getFlashChipSize() / (1024 * 1024)) +
             " psram_mb=" + String(ESP.getPsramSize() / (1024 * 1024)) +
             " free_psram_kb=" + String(ESP.getFreePsram() / 1024) +
             " sense_mv=" + String(mv) + " power=" + String(mv > 2500 ? "yes" : "no") +
             " gate=" + String(gate ? "on" : "off") + " led_pin=" + String(pinLed);
  ok(s);
}

void handle(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;
  String up = cmd; up.toUpperCase();

  // split into words
  String w[6]; int n = 0;
  { int i = 0; while (i < (int)up.length() && n < 6) { while (i < (int)up.length() && up[i] == ' ') i++; int j = i; while (j < (int)up.length() && up[j] != ' ') j++; if (j > i) w[n++] = up.substring(i, j); i = j; } }

  if (w[0] == "PING") { ok("PONG plantbot-test v1"); return; }
  if (w[0] == "INFO") { cmdInfo(); return; }

  if (w[0] == "SENSE") {
    uint32_t mv = senseMilliVolts();
    // The ADC tops out near 3.1 V, so a full 5 V rail (3.33 V at the pin) reads as "at least" ~4.6 V.
    char b[96]; snprintf(b, sizeof b, "SENSE mv=%lu rail_v=%s%.2f power=%s", (unsigned long)mv, mv > 3000 ? ">=" : "", mv * 1.5f / 1000.0f, mv > 2500 ? "yes" : "no");
    ok(b); return;
  }
  if (w[0] == "GATE") { gate = w[1] != "0" && w[1] != "OFF"; ok(String("GATE ") + (gate ? "on" : "off")); return; }

  if (w[0] == "LED") {
    if (w[1] == "PIN") { pinLed = w[2].toInt(); ok("LED pin=" + String(pinLed)); return; }
    int r = w[1].toInt(), g = w[2].toInt(), b = w[3].toInt();
    rgbLedWrite(pinLed, r, g, b);
    ok("LED " + String(r) + " " + String(g) + " " + String(b)); return;
  }

  if (w[0] == "PSRAM") {
    size_t sz = 512 * 1024;
    uint8_t *p = (uint8_t *)ps_malloc(sz);
    if (!p) { err("PSRAM allocation failed. Check that OPI PSRAM is enabled in the board settings."); return; }
    for (size_t i = 0; i < sz; i++) p[i] = (uint8_t)(i * 7 + 3);
    size_t bad = 0; for (size_t i = 0; i < sz; i++) if (p[i] != (uint8_t)(i * 7 + 3)) bad++;
    bool ext = esp_ptr_external_ram(p);
    free(p);
    if (bad || !ext) { err("PSRAM test failed: bad_bytes=" + String(bad) + " external=" + String(ext)); return; }
    ok("PSRAM 512 KB write/read passed, external=yes"); return;
  }

  if (w[0] == "LCD") {
    displayBegin();
    if (w[1] == "INIT")    { backlight(255); tft.fillScreen(ST77XX_BLACK); ok("LCD ready " + String(tft.width()) + "x" + String(tft.height())); return; }
    if (w[1] == "TEST")    { backlight(255); drawPattern(); ok("LCD test pattern"); return; }
    if (w[1] == "FACE")    { backlight(255); drawFace(w[2] != "SAD"); ok(String("LCD face ") + (w[2] == "SAD" ? "sad" : "happy")); return; }
    if (w[1] == "FILL")    { backlight(255); long c = strtol(w[2].c_str(), nullptr, 16);
                             uint16_t c565 = rgb565((c >> 16) & 255, (c >> 8) & 255, c & 255); tft.fillScreen(c565); ok("LCD fill " + hexColorName(c565)); return; }
    if (w[1] == "BL")      { int lv = w[2].toInt(); backlight(lv); ok("LCD backlight " + String(constrain(lv, 0, 255))); return; }
    if (w[1] == "INV")     { bool on = w[2] != "0"; tft.invertDisplay(on); drawPattern(); ok(String("LCD invert ") + (on ? "on" : "off")); return; }
    if (w[1] == "ROT")     { int r = w[2].toInt() & 3; tft.setRotation(r); drawPattern(); ok("LCD rotation " + String(r)); return; }
    if (w[1] == "SPEED")   { uint32_t t0 = millis(); for (int i = 0; i < 10; i++) tft.fillScreen(i & 1 ? ST77XX_BLUE : ST77XX_GREEN);
                             uint32_t dt = millis() - t0; ok("LCD 10 full frames in " + String(dt) + " ms (" + String(10000.0f / dt, 1) + " fps)"); return; }
    err("LCD needs INIT, TEST, FACE, FILL rrggbb, BL 0-255, INV 0|1, ROT 0-3 or SPEED"); return;
  }

  if (w[0] == "SERVO") {
    if (w[1] == "OFF") { servoRelease(0); servoRelease(1); ok("SERVO released"); return; }
    if (!needPower("Servos")) return;
    if (w[1] == "SWEEP") {
      for (int d = 90; d <= SERVO_MAX_DEG; d += 2) { servoWrite(0, d); servoWrite(1, 180 - d); delay(15); }
      for (int d = SERVO_MAX_DEG; d >= SERVO_MIN_DEG; d -= 2) { servoWrite(0, d); servoWrite(1, 180 - d); delay(15); }
      for (int d = SERVO_MIN_DEG; d <= 90; d += 2) { servoWrite(0, d); servoWrite(1, 180 - d); delay(15); }
      ok("SERVO sweep done"); return;
    }
    if (w[1] == "WAVE") {
      for (int k = 0; k < 3; k++) { servoWrite(0, 140); servoWrite(1, 40); delay(250); servoWrite(0, 60); servoWrite(1, 120); delay(250); }
      servoWrite(0, 90); servoWrite(1, 90); ok("SERVO wave done"); return;
    }
    int deg = w[2].toInt(), clamped = constrain(deg, SERVO_MIN_DEG, SERVO_MAX_DEG);
    String note = clamped != deg ? " (clamped from " + String(deg) + ")" : "";
    if (w[1] == "L" || w[1] == "BOTH") servoWrite(0, clamped);
    if (w[1] == "R" || w[1] == "BOTH") servoWrite(1, clamped);
    if (w[1] != "L" && w[1] != "R" && w[1] != "BOTH") { err("SERVO needs L, R, BOTH, SWEEP, WAVE or OFF"); return; }
    ok("SERVO " + w[1] + " " + String(clamped) + note); return;
  }

  if (w[0] == "TONE" || w[0] == "SWEEP" || w[0] == "MELODY" || w[0] == "PSRAMAUDIO") {
    if (!needPower("The amp")) return;
    if (!audioBegin()) { err("I2S failed to start"); return; }
    if (w[0] == "TONE") {
      float f = w[1].length() ? w[1].toFloat() : 440; int ms = w[2].length() ? w[2].toInt() : 800; int vol = w[3].length() ? w[3].toInt() : 30;
      playTone(f, f, constrain(ms, 20, 5000), vol); ok("TONE " + String(f, 0) + " Hz " + String(ms) + " ms vol " + String(vol)); return;
    }
    if (w[0] == "SWEEP") {
      int vol = w[1].length() ? w[1].toInt() : 30;
      playTone(150, 6000, 2500, vol); ok("SWEEP 150 to 6000 Hz"); return;
    }
    if (w[0] == "MELODY") {
      int vol = w[1].length() ? w[1].toInt() : 30;
      const float notes[] = { 523.25, 659.25, 783.99, 1046.5 };
      for (float f : notes) playTone(f, f, 160, vol);
      ok("MELODY done"); return;
    }
    // PSRAMAUDIO: render 2 s into a PSRAM buffer, then play it back — the same path speech will use.
    size_t frames = SAMPLE_RATE * 2, bytes = frames * 4;
    int16_t *buf = (int16_t *)ps_malloc(bytes);
    if (!buf) { err("Could not allocate the audio buffer in PSRAM"); return; }
    for (size_t i = 0; i < frames; i++) {
      float t = (float)i / SAMPLE_RATE, f = 300 + 200 * sinf(2 * PI * 3 * t);
      float env = min(1.0f, min(t * 20, (2.0f - t) * 20));
      int16_t s = (int16_t)(sinf(2 * PI * f * t) * 9000 * env);
      buf[2 * i] = s; buf[2 * i + 1] = s;
    }
    uint32_t t0 = millis();
    i2s.write((uint8_t *)buf, bytes);
    uint32_t dt = millis() - t0;
    free(buf);
    ok("PSRAMAUDIO 2 s played from PSRAM in " + String(dt) + " ms"); return;
  }

  if (w[0] == "PIEZO") {
    ledcAttachChannel(PIN_PIEZO, 2000, 10, CH_PIEZO);
    if (w[1] == "CHIRP") {
      for (int f = 1500; f <= 4500; f += 150) { ledcWriteTone(PIN_PIEZO, f); delay(12); }
      for (int k = 0; k < 2; k++) { ledcWriteTone(PIN_PIEZO, 4000); delay(60); ledcWriteTone(PIN_PIEZO, 0); delay(60); }
    } else {
      int f = w[1].length() ? w[1].toInt() : 4000, ms = w[2].length() ? w[2].toInt() : 300;
      ledcWriteTone(PIN_PIEZO, constrain(f, 100, 10000)); delay(constrain(ms, 10, 3000));
    }
    ledcWriteTone(PIN_PIEZO, 0); ledcDetach(PIN_PIEZO);
    pinMode(PIN_PIEZO, OUTPUT); digitalWrite(PIN_PIEZO, LOW);
    ok("PIEZO done"); return;
  }

  if (w[0] == "HELP") {
    ok("PING INFO SENSE GATE 0|1 LED r g b|LED PIN n PSRAM LCD INIT|TEST|FACE [SAD]|FILL rrggbb|BL n|INV 0|1|ROT n|SPEED "
       "SERVO L|R|BOTH deg|SWEEP|WAVE|OFF TONE f ms vol SWEEP vol MELODY vol PSRAMAUDIO PIEZO f ms|CHIRP"); return;
  }
  err("Unknown command: " + cmd + ". Send HELP for the list.");
}

// ======================================================================
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SENSE, ADC_11db);
  // Hold actuator pins low until a test asks for them.
  for (int p : { PIN_SERVO_L, PIN_SERVO_R, PIN_PIEZO }) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(PIN_TFT_BL, OUTPUT); digitalWrite(PIN_TFT_BL, LOW);
  rgbLedWrite(pinLed, 0, 8, 0);   // dim green: firmware is running
  delay(300);
  Serial.println("EVT READY plantbot-test v1");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { if (line.length()) { handle(line); line = ""; } }
    else if (line.length() < 200) line += c;
  }
  delay(2);
}
