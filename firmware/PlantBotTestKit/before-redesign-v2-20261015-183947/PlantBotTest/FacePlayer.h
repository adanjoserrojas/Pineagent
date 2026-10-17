#pragma once
#include <Arduino.h>
#include <Adafruit_ST7789.h>
#include <esp_heap_caps.h>
#include "FaceAssets.h"
#include "FaceDecoder.h"

class CompanionFacePlayer {
 public:
  explicit CompanionFacePlayer(Adafruit_ST7789& display) : display_(display) {}

  bool begin(bool (*hasPower)()) {
    if (task_) return true;
    hasPower_ = hasPower;
    mutex_ = xSemaphoreCreateMutex();
    if (!mutex_) return false;
    pixels_ = static_cast<uint16_t*>(heap_caps_malloc(320 * 170 * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!pixels_) pixels_ = static_cast<uint16_t*>(heap_caps_malloc(320 * 170 * sizeof(uint16_t), MALLOC_CAP_8BIT));
    scratch_ = static_cast<uint8_t*>(malloc(FACE_MAX_RLE_BYTES));
    if (!pixels_ || !scratch_) {
      free(pixels_); free(scratch_); pixels_ = nullptr; scratch_ = nullptr;
      vSemaphoreDelete(mutex_); mutex_ = nullptr; return false;
    }
    started_ = millis(); enabled_ = true;
    if (xTaskCreatePinnedToCore(taskEntry, "companion-face", 4096, this, 1, &task_, 1) != pdPASS) {
      free(pixels_); free(scratch_); pixels_ = nullptr; scratch_ = nullptr;
      vSemaphoreDelete(mutex_); mutex_ = nullptr; task_ = nullptr; return false;
    }
    return true;
  }

  bool play(const String& name) {
    if (!task_) return false;
    String key = name; key.toLowerCase(); key.replace('-', '_');
    for (size_t i = 0; i < FACE_CLIP_COUNT; ++i) {
      if (key != FACE_CLIPS[i].name) continue;
      xSemaphoreTake(mutex_, portMAX_DELAY);
      clip_ = i; started_ = millis(); lastFrame_ = UINT16_MAX;
      demo_ = false; enabled_ = true; decodeError_ = false;
      xSemaphoreGive(mutex_); return true;
    }
    return false;
  }

  bool demo() {
    if (!play("idle")) return false;
    xSemaphoreTake(mutex_, portMAX_DELAY); demo_ = true; demoStarted_ = millis();
    xSemaphoreGive(mutex_); return true;
  }

  void stop() {
    if (!mutex_) return;
    // Wait for an in-flight SPI transfer before a legacy LCD command draws.
    xSemaphoreTake(mutex_, portMAX_DELAY); enabled_ = false; demo_ = false;
    xSemaphoreGive(mutex_);
  }

  bool setPowerBadge(const String& mode) {
    if (!mutex_) return false;
    const int value = mode == "AUTO" ? -1 : mode == "ON" ? 1 : mode == "OFF" ? 0 : -2;
    if (value == -2) return false;
    xSemaphoreTake(mutex_, portMAX_DELAY); powerBadge_ = value; lastFrame_ = UINT16_MAX;
    xSemaphoreGive(mutex_); return true;
  }

  String status() {
    if (!mutex_) return "ANIM unavailable (frame buffer allocation or task creation failed)";
    xSemaphoreTake(mutex_, portMAX_DELAY);
    String value = String("ANIM state=") + FACE_CLIPS[clip_].name +
      " playing=" + (enabled_ ? "yes" : "no") + " demo=" + (demo_ ? "yes" : "no") +
      " target_fps=20 measured_fps=" + String(measuredFps_, 1) +
      " frame=" + String(lastFrame_) + " decode_error=" + (decodeError_ ? "yes" : "no");
    xSemaphoreGive(mutex_); return value;
  }

 private:
  static void taskEntry(void* self) { static_cast<CompanionFacePlayer*>(self)->run(); }

  bool draw(size_t clipIndex, uint16_t frame) {
    const FaceClip& clip = FACE_CLIPS[clipIndex];
    const uint32_t begin = clip.offsets[frame], end = clip.offsets[frame + 1];
    size_t unpacked = 0;
    if (end < begin || !faceUnpackLz4(clip.data + begin, end - begin, scratch_, FACE_MAX_RLE_BYTES, unpacked) ||
        !faceExpandRuns(scratch_, unpacked, clip.palette, pixels_, 320 * 170)) return false;
    const bool badge = powerBadge_ == 1 || (powerBadge_ == -1 && !powerPresent_);
    if (badge) {
      for (size_t y = 0; y < 24; ++y)
        memcpy(pixels_ + (16 + y) * 320 + 134, FACE_POWER_BADGE + y * 52, 52 * sizeof(uint16_t));
    }
    display_.startWrite();
    display_.setAddrWindow(0, 0, 320, 170);
    display_.writePixels(pixels_, 320 * 170, true);
    display_.endWrite(); return true;
  }

  void run() {
    uint32_t count = 0, sampleStarted = millis(), lastSense = 0;
    for (;;) {
      const uint32_t now = millis();
      if (now - lastSense >= 500 || lastSense == 0) {
        powerPresent_ = hasPower_ ? hasPower_() : true; lastSense = now;
      }
      xSemaphoreTake(mutex_, portMAX_DELAY);
      if (enabled_) {
        const uint32_t renderNow = millis();
        if (demo_) {
          const size_t next = ((renderNow - demoStarted_) / 6000) % FACE_CLIP_COUNT;
          if (next != clip_) { clip_ = next; started_ = renderNow; lastFrame_ = UINT16_MAX; }
        }
        const FaceClip& clip = FACE_CLIPS[clip_];
        const uint16_t frame = (uint64_t(renderNow - started_) * clip.fps / 1000) % clip.frameCount;
        if (frame != lastFrame_) {
          if (display_.width() != 320 || display_.height() != 170 || !draw(clip_, frame)) {
            decodeError_ = true; enabled_ = false;
          } else { lastFrame_ = frame; ++count; }
        }
      }
      if (now - sampleStarted >= 1000) {
        measuredFps_ = count * 1000.0f / (now - sampleStarted); count = 0; sampleStarted = now;
      }
      xSemaphoreGive(mutex_);
      vTaskDelay(pdMS_TO_TICKS(2));
    }
  }

  Adafruit_ST7789& display_;
  SemaphoreHandle_t mutex_ = nullptr;
  TaskHandle_t task_ = nullptr;
  uint16_t* pixels_ = nullptr;
  uint8_t* scratch_ = nullptr;
  bool (*hasPower_)() = nullptr;
  size_t clip_ = 0;
  uint32_t started_ = 0, demoStarted_ = 0;
  uint16_t lastFrame_ = UINT16_MAX;
  bool enabled_ = false, demo_ = false, decodeError_ = false, powerPresent_ = false;
  int powerBadge_ = -1;
  float measuredFps_ = 0;
};
