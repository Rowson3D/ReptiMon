# MoMo Enclosure

A self-hosted ESP32S3-based environmental monitor and Web UI for reptile enclosures. It measures temperature and humidity, computes comfort scoring against configurable thresholds, and serves a responsive dashboard over Wi‑Fi with live charts, history, and basic system diagnostics.

## Features

- Embedded web server (ESP32 AsyncWebServer) serving a single-page Web UI from LittleFS
- Live telemetry via WebSocket with REST polling fallback
- Temperature, humidity, dew point, heat index, VPD, and derived comfort score
- User-configurable thresholds for Temperature, Humidity, and Comfort (Min/Ideal/Max)
- Clear status labels (Perfect/Caution/Alert) based on thresholds
- Live chart with pan/zoom, hover tooltips, autoscale/manual scaling, and PNG export
- Persistent UI settings and history across reloads (localStorage)
- Network info with stable SSID display (STA preferred, AP fallback), no flicker
- System panel: uptime, CPU freq, heap/PSRAM usage, flash/FS stats, Wi‑Fi mode, mDNS
- Optional camera status indicator

## Hardware

- Board: Seeed XIAO ESP32S3
- Sensors: Digital temperature/humidity sensor supported by the firmware (see `camera_module.*` and configuration)
- Storage: On‑chip flash using LittleFS to host Web UI assets
- Optional: Camera module (for status only in Web UI)

## Software Requirements

- Windows 10/11
- PlatformIO Core (installed automatically via VS Code PlatformIO extension)
- VS Code recommended

## Project Structure

```
platformio.ini
include/
lib/
src/
  main.cpp
  main-webserver.cpp
  camera_module.cpp
data/
  index.html, portal.html, script.js, style.css
  components/ (dashboard, network, settings, system)
  js/ (core.js, main.js, dashboard.js, history.js, components-*.js)
  partials/ (header.html, footer.html)
  vendor/ (microplot.js)
WebUI/  # optional workspace folder for UI assets
```

Key files:
- `src/main-webserver.cpp` — Serves Web UI, telemetry JSON, settings persistence, Wi‑Fi status
- `data/` — LittleFS web content (HTML/CSS/JS)
- `include/app_settings.h` — Settings and thresholds types

## Getting Started

1) Build the filesystem image (LittleFS):
- In VS Code: Terminal > Run Task > "Build LittleFS Image"
- Or use the PlatformIO task already provided in this workspace

2) Upload firmware and filesystem to the device:
- Upload firmware: Use PlatformIO "Upload (seeed_xiao_esp32s3)"
- Upload LittleFS: Use PlatformIO "Upload Filesystem Image (seeed_xiao_esp32s3)"

3) Connect to the device:
- STA mode: Connect device to your Wi‑Fi (see Network tab)
- AP mode: Connect to its access point and browse to 192.168.4.1

4) Open the Web UI:
- Use the device IP or mDNS hostname (if enabled): http://<hostname>.local/

Notes for Windows cmd.exe users: all PlatformIO tasks in this repo are configured; prefer the PlatformIO toolbar/tasks over raw commands.

## Web UI Overview

Dashboard
- Hero cards show Temperature, Humidity, Comfort score, deltas, and trends
- Micro‑sparklines show the last 30 minutes
- Live chart supports wheel zoom, drag to pan, double‑click to reset

Settings
- Compact thresholds grid for Temperature, Humidity, Comfort (Min/Ideal/Max)
- Values persist on the device; the UI reflects saved values

Network
- Shows Wi‑Fi STA/AP info, SSID, RSSI, IP, hostname, mode badges
- SSID display is stable with no flicker (STA preferred, AP name fallback)

System
- Uptime, CPU, heap/PSRAM, flash/FS usage, chip info, MACs, mDNS state

Header/Footer
- Simplified header (no host/IP/SSID clutter)
- Footer shows Temp, RH, stable SSID/RSSI, and last update time

## Comfort Scoring and Status

- User thresholds define Min/Ideal/Max for temperature and humidity
- Subscores map linearly: ideal = 100, min/max = 50, taper to 0 beyond range
- Comfort score is the mean of Temp and Humidity subscores when both are valid
- Comfort label:
  - Perfect when score within Comfort Min..Max
  - Caution when moderately outside
  - Alert when far outside

Temperature/Humidity status text
- "Perfect" when within Min..Max
- "Too Hot/Cold/Wet/Dry" outside limits

## Persistence and Performance

- Client-side persistence via localStorage:
  - Chart autoscale/manual scales, paused state
  - View window (pan/zoom), series colors
  - Recent history (12h cap, point count cap)
- On tab hide, UI throttles/persists to avoid bursts on resume
- On resume, a visibility‑aware draw scheduler performs a single draw and coalesces updates to prevent catch‑up spikes

## Networking and API

Runtime telemetry (primary)
- WebSocket: `ws://<host>/ws` emitting JSON packets with latest reading and system info

Polling fallback
- REST: `GET /api/data` for current reading

Wi‑Fi status
- REST: `GET /api/wifi/status` returns `{ ssid, ip, hostname, rssi, ap, ap_ssid }`
- UI prefers STA SSID; if disconnected and AP active, shows AP SSID

Settings
- REST: `GET /api/settings/get` and `POST /api/settings/save`
- Includes thresholds for temp/humidity/comfort

Note: Exact payload fields may evolve; inspect `src/main-webserver.cpp` for current schema.

## Development Workflow

- Edit Web UI under `data/`
- Build and upload LittleFS after UI changes:
  - PlatformIO task: Build LittleFS Image → Upload Filesystem Image
- Edit firmware under `src/` and upload Firmware when needed
- For quick iteration on UI only, uploading filesystem is sufficient

Quality gates
- The UI code is lint-free in this workspace and tested via manual smoke tests
- PlatformIO builds and uploads are successful (see VS Code tasks)

## Troubleshooting

- UI doesn’t update or seems choppy after overnight idle
  - Ensure the current firmware/UI includes the visibility‑aware scheduler
  - Try reloading the page; history and settings will persist

- SSID shows as "--"
  - Device may be in STA disconnected state without AP enabled
  - If AP is active, the footer will fall back to AP SSID

- Can’t reach device at hostname.local
  - Ensure mDNS is enabled and supported on your OS/network
  - Use the device IP address from the Network/System panels

- Uploading filesystem fails
  - Disconnect any serial monitors
  - Rebuild LittleFS image before upload

- Wrong units in UI
  - Units are reported by firmware; confirm settings and conversions on the device

## License

This project is provided as-is for personal use. Add a license here if you plan to distribute.
