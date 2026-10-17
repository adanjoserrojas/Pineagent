#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Independent LZ4 blocks, followed by (run length, palette index) pairs.
// Both stages reject malformed data before writing beyond a buffer.
inline bool faceUnpackLz4(const uint8_t* src, size_t size, uint8_t* dst,
                          size_t capacity, size_t& written) {
  size_t in = 0, out = 0;
  while (in < size) {
    const uint8_t token = src[in++];
    size_t literals = token >> 4;
    if (literals == 15) {
      uint8_t extra;
      do {
        if (in >= size) return false;
        extra = src[in++];
        if (literals > capacity || extra > capacity - literals) return false;
        literals += extra;
      } while (extra == 255);
    }
    if (literals > size - in || literals > capacity - out) return false;
    memcpy(dst + out, src + in, literals);
    in += literals; out += literals;
    if (in == size) { written = out; return true; }
    if (size - in < 2) return false;
    const size_t offset = src[in] | (size_t(src[in + 1]) << 8);
    in += 2;
    if (!offset || offset > out) return false;
    size_t match = token & 15;
    if (match == 15) {
      uint8_t extra;
      do {
        if (in >= size) return false;
        extra = src[in++];
        if (match > capacity || extra > capacity - match) return false;
        match += extra;
      } while (extra == 255);
    }
    if (match > capacity - out || 4 > capacity - out - match) return false;
    match += 4;
    for (size_t n = 0; n < match; ++n) {
      dst[out] = dst[out - offset]; ++out;
    }
  }
  return false;
}

inline bool faceExpandRuns(const uint8_t* runs, size_t size,
                           const uint16_t* palette, uint16_t* pixels,
                           size_t count) {
  if (size & 1) return false;
  size_t out = 0;
  for (size_t i = 0; i < size; i += 2) {
    const size_t run = runs[i];
    const uint8_t index = runs[i + 1];
    if (!run || index >= 64 || run > count - out) return false;
    const uint16_t color = palette[index];
    for (size_t n = 0; n < run; ++n) pixels[out++] = color;
  }
  return out == count;
}
