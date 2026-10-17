## Continuous animated viewport

The new 18-state screen-test firmware and flashable binary are ready. Start with [VIEWPORT_ANIMATIONS.md](VIEWPORT_ANIMATIONS.md). Flash `prebuilt/PlantBotTest-AnimatedFaces-8MB-merged.bin` at `0x0`, then use the animated-face controls under card 3 in the updated test bench. The older binary below remains available for the original component tests.

# Plant Bot Test Kit

Two pieces:

- `PlantBotTest/PlantBotTest.ino`: test firmware. It answers plain-text commands over the native USB port.
- `PlantBot-TestBench.html`: a local page that talks to that firmware from Chrome or Edge using Web Serial. It has a pass/fail checklist for Robot A and Robot B.

## 1. Flash the firmware (pick one way)

### A. Arduino IDE (recommended, ~10 min the first time)

1. Add the board package. Go to Boards Manager, search **esp32 by Espressif**, and install **3.3.x**. Version 3.x is required; 2.x will not compile this sketch.
2. Install the library. Go to Library Manager, search **Adafruit ST7735 and ST7789 Library**, install it, and say **Install all** to the dependency prompt.
3. Under Tools, set:

   | Setting | Value |
   |---|---|
   | Board | **ESP32S3 Dev Module** |
   | USB CDC On Boot | **Enabled** |
   | USB Mode | Hardware CDC and JTAG |
   | PSRAM | **OPI PSRAM** |
   | Flash Size | **8MB**. Use 16MB if the metal can says N16R8. |
   | Partition Scheme | Default |

4. Plug in the USB-C socket labelled **USB** (the native port, not COM/UART), pick its port, and click Upload.
5. If the upload hangs on "Connecting…": hold **BOOT**, tap **RST**, release BOOT, then upload again. After it finishes, tap **RST** once.

### B. No install: the prebuilt binary in the browser

1. Open https://espressif.github.io/esptool-js/ in Chrome and click **Connect**. Pick the board.
2. Set Flash Address to `0x0` and choose the file `prebuilt/PlantBotTest-8MB-merged.bin`.
3. Click **Program**, then tap **RST** when it's done. This also works on N16R8 modules.

If you prefer the command line: `esptool.py --chip esp32s3 write_flash 0x0 prebuilt/PlantBotTest-8MB-merged.bin`.

### C. PlatformIO

Run `pio run -t upload` in this folder. It uses `platformio.ini`.

## 2. Run the test bench

1. Close the Arduino Serial Monitor. Only one program can hold the port at a time.
2. Double-click `PlantBot-TestBench.html` so it opens in **Chrome or Edge**. Click **Connect**.
   - If no port is listed, untick *native USB only*.
   - If the page says Web Serial is missing, serve the folder instead. Run `python -m http.server 8000` in this folder and open http://localhost:8000/PlantBot-TestBench.html.
3. Work through the cards **top to bottom**:
   - **USB only:** card 1 (board) and card 3 (display).
   - **Plug the 5 V brick in:** card 2 (sense), card 4 (arms), card 5 (speaker), card 6 (piezo).
   - Unplug the brick once to pass "Brick off reads low".
4. Switch to **Robot B** at the top right and repeat with the second robot. **Copy report** puts both robots' results on the clipboard.

Results are saved in this browser. Checks marked *auto* fill in from the firmware's replies; you judge the rest by eye and ear.

## Safety gate

Servo and amp commands are refused unless GPIO7 sees the brick (above 2.5 V on the pin). This stops a test from pulling servo current through the laptop's USB port if someone miswired the power board. Untick *safety gate* (sends `GATE 0`) only if the sense divider itself is what you're debugging.

## If the page loses the board mid-test

The native USB port vanishes whenever the chip resets. If that happens during **Wave** or a loud tone, the page shows a **brown-out** warning. That means the 5 V rail sagged under load. Check:

- the 1000 µF capacitor (polarity!),
- that the servos and amp run from the brick and not the ESP32's 5V pin,
- the star ground.

With *auto-reconnect* ticked, the page reopens the port when the board comes back.

## Command reference

You can type these in the log box. Each command gets exactly one `OK …` or `ERR …` line back.

| Command | Does |
|---|---|
| `PING` / `INFO` / `HELP` | handshake / chip, flash, PSRAM, sense / list |
| `PSRAM` | 512 KB write/read check in external RAM |
| `LED r g b`, `LED PIN 38` | on-board RGB LED (default pin 48) |
| `SENSE`, `GATE 0/1` | read the brick-sense divider, toggle the safety gate |
| `LCD INIT/TEST/FACE [SAD]/SPEED` | display init, colour bars + edge frame, face, fps benchmark |
| `LCD FILL rrggbb`, `LCD BL 0-255`, `LCD INV 0/1`, `LCD ROT 0-3` | fill, backlight PWM, inversion, rotation |
| `SERVO L/R/BOTH deg`, `SERVO SWEEP/WAVE/OFF` | arms, clamped 20–160° |
| `TONE hz ms vol`, `SWEEP vol`, `MELODY vol`, `PSRAMAUDIO` | I2S speaker; vol is a % |
| `PIEZO hz ms`, `PIEZO CHIRP` | piezo via LEDC |

## Pin map (same as the wiring map)

| Part | Pins |
|---|---|
| Display | SCL 12, SDA 11, CS 10, DC 9, RES 14, BLK 21, VCC 3V3 |
| Amp | BCLK 4, LRC 5, DIN 6 |
| Servos | L 15, R 16 |
| Piezo | 17 |
| Sense | 7 |
