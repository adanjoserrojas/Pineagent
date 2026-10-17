# Animated viewport screen test

This version plays the 18 companion faces continuously on the 320 x 170 ST7789 display. It uses the existing test-kit wiring and native USB commands. The face starts in idle after boot.

## Test today

1. Flash `prebuilt/PlantBotTest-AnimatedFaces-8MB-merged.bin` at address **0x0** using the same ESP Web Tools page described in the main README. This is a merged image containing the new partition table and animation assets. The older `PlantBotTest-8MB-merged.bin` does not contain these animations.
2. Reset the board. The idle eyes should keep moving and blinking.
3. Open `PlantBot-TestBench.html` in Chrome or Edge and connect to the native USB port.
4. Under **3 - Face display**, click **Cycle all 18 faces**, or select an individual expression. Each individual expression loops until another is selected. The demo changes faces every six seconds.
5. Click **Animation status / FPS**. The target is 20 fps; `measured_fps` reports what the board actually achieved. Allow one second for the measurement to settle. `decode_error` should be `no`.
6. Check all four display edges, colors, blinks and loop boundaries. Run a speaker or servo test while a face is selected; animation uses a separate task and should keep moving.

The amber plug badge means external motor/amp power is absent. It overlays the live face and retains that face's color. **Hide for display test** only hides the badge; the existing actuator safety gate still applies.

Static pattern, fill, inversion, rotation and speed tests stop the animation. Select a face to resume. Animation requires landscape rotation 1 or 3; use `LCD ROT 1` if needed.

## Commands

| Command | Behavior |
| --- | --- |
| `LCD ANIM IDLE` | Start the continuous idle loop |
| `LCD ANIM <state>` or `STATE <state>` | Select a loop from the table below |
| `LCD ANIM LIST` | List all names |
| `LCD ANIM STATUS` | Current state, playback and measured FPS |
| `LCD ANIM OFF` | Stop, leaving the last frame visible |
| `LCD DEMO` | Cycle all 18 treatments indefinitely |
| `LCD POWER AUTO` | Show the power badge according to the existing GPIO7 sense circuit |
| `LCD POWER ON` / `LCD POWER OFF` | Force the badge visible / hidden for visual testing |

## State coverage

| Name | Color / emotion | Source |
| --- | --- | --- |
| `idle` | White, relaxed slow blink | Design section 9 |
| `planning` | Blue, curious upward gaze | Design section 9 |
| `routing` | Purple, scanning | Design section 9 |
| `executing` | Green pulse, focused | Design section 9 |
| `awaiting_approval` | Amber, wide hopeful eyes | Design section 9 |
| `blocked` | Dim amber, half-closed patient eyes | Design section 9 |
| `error` | Red, X eyes and gentle wobble | Design section 9 |
| `done` | Green, smiling celebration | Design section 9 |
| `disconnected` | Muted slate, searching/sad | Design section 10; visual proposed |
| `no_motor_power` | Executing example plus amber plug badge | Design section 10 |
| `team_join` | Welcoming smile, white over idle | Design section 9 |
| `team_leave` | Gentle farewell, white over idle | Design section 9 |
| `routing_cache` | Purple scan with cache indicator | Design section 2 |
| `routing_llm` | Purple scan with fallback indicator | Design section 2 |
| `speaking` | Mouth movement over planning example | Hardware brief + section 10 |
| `paused` | Amber with pause marker | Lifecycle documented; visual proposed |
| `parked` | Dim amber, sleepy breathing | Lifecycle documented; visual proposed |
| `reconnecting` | Slate, waking up | State restoration documented; visual proposed |

## Implementation and limits

The editable design sources are [Figma](https://www.figma.com/design/0HTnuMyAMeuy01nco9QaOg) and [Rive](https://editor.rive.app/file/pineapple/2654454). Native frames were rendered from the Rive timelines at 20 fps, then palette-encoded to RGB565 and compressed as independent LZ4/RLE frames. The firmware decompresses into one frame buffer and writes a full frame over SPI at 40 MHz. No Rive runtime is required on the microcontroller.

All 984 source frames were validated, including corner coverage and nonblank first frames. The C++ decoder checks frame lengths, palette indices and buffer bounds. A host verification compares the decoded data with a source hash for every frame. The firmware must still be measured on the physical display; a successful build does not establish achieved FPS or panel color order.

`FacePlayer.h` owns the display during animation. Legacy static LCD tests wait for the animation transfer to finish before taking control. Animation continues in a FreeRTOS task during blocking audio and servo tests.

This is the existing plain-text hardware test firmware. Production COBS/CRC event handling, run priority, done-to-idle scheduling, event overlay return behavior, arm choreography and speech synchronization belong to the application bridge. The test bench deliberately lets each selected face loop continuously. The standalone speaking, team and router treatments are preview examples; automatic power indication is composited over any selected face.

## Building

Use `pio run` in this directory. `platformio.ini` selects the 8 MB partition layout in `partitions-face-8mb.csv`; the large animation assets need this layout. Keep PSRAM enabled as configured. The generated merged image is `.pio/build/plantbot/firmware.factory.bin`.

For Arduino IDE, keep `partitions.csv` beside the sketch, select ESP32S3 Dev Module, 8 MB flash, OPI PSRAM and native USB CDC as in the main README. Flashing the new merged binary is the quickest route for this screen test.
