#pragma once
#include <stdint.h>

inline uint16_t faceBlend565(uint16_t background, uint16_t foreground, uint8_t alpha) {
  if (alpha == 0) return background;
  if (alpha == 255) return foreground;
  const unsigned inverse = 255 - alpha;
  const unsigned r = (((background >> 11) & 31) * inverse + ((foreground >> 11) & 31) * alpha + 127) / 255;
  const unsigned g = (((background >> 5) & 63) * inverse + ((foreground >> 5) & 63) * alpha + 127) / 255;
  const unsigned b = ((background & 31) * inverse + (foreground & 31) * alpha + 127) / 255;
  return (r << 11) | (g << 5) | b;
}
