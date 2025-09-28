## [v0.1.0] — 2025-09-27

### Added
- Over‑the‑air updates (OTA) via GitHub Releases
  - Endpoints: `GET /api/ota/check`, `POST /api/ota/update`
  - System panel buttons: “Check for Update” and “Apply Update”
  - Configurable via build flags: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_ASSET_NAME` (defaults to `firmware.bin`)
  - Firmware version exposed in telemetry as `system.fwVersion`
- Comfort configuration
  - Min/Ideal/Max thresholds for Temperature, Humidity, and Comfort (0–100)
  - Comfort and status labels use configured thresholds; “Perfect” inside Min..Max
- Chart features
  - Pan/zoom (wheel zoom, drag‑to‑pan), hover tooltips, PNG export
  - Persisted settings: autoscale/manual ranges, paused state, view window, series colors
- System diagnostics
  - Extended system info: uptime, CPU, heap/PSRAM, flash/FS, Wi‑Fi mode, mDNS, MACs
  - Camera status and streaming endpoints (if camera present)

### Changed
- Comfort scoring uses raw temperature for its subscore (instead of heat index)
- Settings UI reorganized into a compact grid for Min/Ideal/Max
- Header simplified (removed Host/IP/SSID from the header; network info lives in footer/System)

### Fixed
- SSID flicker eliminated by consolidating updates and avoiding unnecessary DOM writes
- Quick Info SSID displays reliably (STA preferred; AP fallback when STA disconnected)

### Performance
- Visibility‑aware draw scheduler for the live chart prevents bursty catch‑up after long tab inactivity
- History persistence throttled; history capped to 12 hours and point count limited

### Networking and API
- Live data over WebSocket: `ws://<host>/ws` (REST polling fallback: `GET /api/data`)
- Wi‑Fi status: `GET /api/wifi/status` (includes `ssid`, `ip`, `hostname`, `rssi`, AP flags)
- Settings: `GET /api/settings/get`, `POST /api/settings/save`

### Assets (attach to this release)
- Required
  - `firmware.bin` — application firmware used by OTA
- Optional
  - `firmware.sha256` — checksum for integrity verification
  - `firmware.elf` / `firmware.map` — debugging artifacts
  - `littlefs.bin` — filesystem image for manual flashing of the Web UI (not used by current OTA)

### Compatibility
- Board: Seeed XIAO ESP32S3
- OTA expects an asset named `firmware.bin` (or the name set via `GITHUB_ASSET_NAME`)
- Keep `FW_VERSION` (in `platformio.ini`) aligned with the release tag for correct update checks

### Known Limitations
- OTA updates only the application partition; it does not update LittleFS. To update the Web UI files, upload the filesystem image separately via PlatformIO.
- TLS currently uses an “insecure” client for simplicity. Certificate pinning can be added in a future release.
- Release checks use GitHub’s `releases/latest`. Prereleases are not considered unless the logic is extended.
