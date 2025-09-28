#include <Arduino.h>
#include <Wire.h>
#include <SHT85.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <ctype.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
// Camera support
#include "esp_camera.h"

// WiFi Configuration - managed via Preferences and Web UI
String selectedSSID = "";
String selectedPassword = "";
Preferences preferences; // stores ssid/pass persistently
Preferences appPrefs;    // stores app settings persistently

// Access Point configuration (fallback / entry point mode)
String ap_ssid_dyn = "";          // e.g., ReptiMon-ABC123
const char* ap_password = "reptile123";
bool useAccessPoint = false;       // whether AP is currently active
bool captivePortalActive = false;  // whether DNS redirect is active
DNSServer dnsServer;               // captive portal DNS server
const byte DNS_PORT = 53;

// Create SHT30 sensor object with default address 0x44
SHT85 sht30(0x44);

// Web server on port 80
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// ESP32 XIAO S3 Built-in LEDs
#define LED_BUILTIN_RED   21  // Red LED
#define LED_BUILTIN_BLUE  2   // Blue/Yellow LED

// Performance optimization constants
#define SENSOR_UPDATE_INTERVAL_MS     50    // Ultra-fast 20Hz updates (50ms)
#define DISPLAY_UPDATE_INTERVAL_MS    100   // 10Hz display updates (100ms)
#define SERIAL_BAUD_RATE             921600 // Maximum reliable baud rate
#define I2C_CLOCK_SPEED              400000 // Fast I2C (400kHz)

// FreeRTOS task handles and synchronization
TaskHandle_t sensorTaskHandle = NULL;
TaskHandle_t displayTaskHandle = NULL;
TaskHandle_t ledTaskHandle = NULL;
TaskHandle_t webTaskHandle = NULL;
QueueHandle_t sensorDataQueue = NULL;
SemaphoreHandle_t dataMutex = NULL;

// Application settings persisted in NVS
struct AppSettings {
  String hostname = "momo"; // mDNS/DHCP hostname
  String units = "C";       // UI display units: "C" or "F"
  float tempMin = 22.0f;
  float tempMax = 32.0f;
  float tempIdeal = 26.0f;
  float humMin = 50.0f;
  float humMax = 80.0f;
  float humIdeal = 65.0f;
  // Comfort index thresholds (0-100)
  float comfortMin = 60.0f;
  float comfortMax = 100.0f;
  float comfortIdeal = 85.0f;
  int camFrameSize = 6;  // FRAMESIZE_QVGA by default
  int camQuality = 12;   // JPEG quality (lower is higher quality)
};
AppSettings appSettings;
String mdnsHostname = "momo";
bool mdnsActive = false;

// Reptile enclosure monitoring variables
struct EnvironmentData {
  float temperature;
  float humidity;
  float dewPoint;
  float heatIndex;
  float vaporPressureDeficit;
  float absoluteHumidity;
  unsigned long timestamp;
  bool valid;
};

// Statistics tracking with lock-free updates
struct Statistics {
  volatile float tempMin, tempMax, tempAvg;
  volatile float humMin, humMax, humAvg;
  volatile float dewMin, dewMax, dewAvg;
  volatile int readingCount;
  volatile bool initialized;
} stats = {0};

// Current data with atomic access
volatile EnvironmentData currentData = {0};
EnvironmentData readings[32]; // Larger buffer for high-frequency data
volatile int readingIndex = 0;

// Reptile care thresholds (adjustable for your species)
struct ReptileThresholds {
  float tempMin = 22.0;      // Minimum safe temperature (°C)
  float tempMax = 32.0;      // Maximum safe temperature (°C)
  float tempIdeal = 26.0;    // Ideal temperature (°C)
  float humMin = 50.0;       // Minimum humidity (%)
  float humMax = 80.0;       // Maximum humidity (%)
  float humIdeal = 65.0;     // Ideal humidity (%)
  // Comfort thresholds (0-100 scale)
  float comfortMin = 60.0;
  float comfortMax = 100.0;
  float comfortIdeal = 85.0;
} thresholds;

// Performance monitoring
unsigned long lastSensorRead = 0;
unsigned long lastDisplayUpdate = 0;
unsigned long sensorReadCount = 0;
unsigned long displayUpdateCount = 0;

// Web server variables
String lastJsonData = "";
unsigned long lastWebUpdate = 0;

// Firmware version and OTA state
#ifndef FW_VERSION
#define FW_VERSION "0.1.0"
#endif
#ifndef GIT_COMMIT
#define GIT_COMMIT "unknown"
#endif
#ifndef BUILD_TIME
#define BUILD_TIME ""
#endif
#ifndef GITHUB_OWNER
#define GITHUB_OWNER "Rowson3D"
#endif
#ifndef GITHUB_REPO
#define GITHUB_REPO  "ReptiMon"
#endif
#ifndef GITHUB_ASSET_NAME
#define GITHUB_ASSET_NAME "firmware.bin"
#endif
// Optional filesystem asset for LittleFS image OTA
#ifndef GITHUB_FS_ASSET_NAME
#define GITHUB_FS_ASSET_NAME "littlefs.bin"
#endif
// Optional GitHub token to avoid anonymous rate limits (set via -DGITHUB_TOKEN="ghp_...")
#ifndef GITHUB_TOKEN
#define GITHUB_TOKEN ""
#endif
static String fwVersion = String(FW_VERSION);
static String fwCommit  = String(GIT_COMMIT);
static String fwBuild   = String(BUILD_TIME);
static const char* kGithubOwner = GITHUB_OWNER;  // override via -DGITHUB_OWNER=\"owner\"
static const char* kGithubRepo  = GITHUB_REPO;   // override via -DGITHUB_REPO=\"repo\"
static const char* kGithubAsset = GITHUB_ASSET_NAME; // override via -DGITHUB_ASSET_NAME=\"name.bin\"
static String otaLatestVersion = "";
static String otaLatestUrl = "";
static volatile bool otaInProgress = false;

// Camera state
bool cameraAvailable = false;
// Camera stream statistics (global across clients)
volatile unsigned long camStatFrames = 0;
volatile unsigned long camStatBytes = 0;
unsigned long camStatStartMs = 0;
// Protect camera operations (stream vs reconfigure)
SemaphoreHandle_t cameraMutex = NULL;

// Forward declarations for camera/settings
bool initCamera();
void loadAppSettings();
void saveAppSettings(const AppSettings &s);

// WiFi control state
volatile bool wifiConnectPending = false;
unsigned long wifiConnectStart = 0;
String pendingSSID = "";
String pendingPass = "";

// Forward declarations
inline float calculateDewPoint(float temp, float humidity);
inline float calculateHeatIndex(float temp, float humidity);
inline float calculateVPD(float temp, float humidity);
inline float calculateAbsoluteHumidity(float temp, float humidity);
String getTemperatureStatus(float temp);
String getHumidityStatus(float humidity);
void updateStatisticsAtomic(float temp, float humidity, float dewPoint);
void updateLEDStatusFast(float temp, float humidity);
void printUltraFastReading(EnvironmentData &data);
void sensorTask(void *parameter);
void displayTask(void *parameter);
void ledTask(void *parameter);
void webTask(void *parameter);
void setupWiFi();
void setupWebServer();
String generateJsonData();
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type,
             void *arg, uint8_t *data, size_t len);

// ---- Version helpers ----
static String normalizeVersion(const String& v) {
  // Trim spaces and a leading 'v' or 'V'
  int i = 0;
  while (i < (int)v.length() && isspace((int)v[i])) i++;
  if (i < (int)v.length() && (v[i] == 'v' || v[i] == 'V')) i++;
  return v.substring(i);
}
static int semverCompare(const String& aIn, const String& bIn) {
  String a = normalizeVersion(aIn), b = normalizeVersion(bIn);
  // Compare dotted numeric parts, non-numeric ignored
  int ia = 0, ib = 0;
  while (ia < (int)a.length() || ib < (int)b.length()) {
    long va = 0, vb = 0;
    // parse next int from a
    while (ia < (int)a.length() && !isdigit((int)a[ia])) ia++;
    while (ia < (int)a.length() && isdigit((int)a[ia])) { va = va * 10 + (a[ia]-'0'); ia++; }
    // skip separators
    while (ia < (int)a.length() && a[ia] != '\0' && !isdigit((int)a[ia])) ia++;
    // parse next int from b
    while (ib < (int)b.length() && !isdigit((int)b[ib])) ib++;
    while (ib < (int)b.length() && isdigit((int)b[ib])) { vb = vb * 10 + (b[ib]-'0'); ib++; }
    while (ib < (int)b.length() && b[ib] != '\0' && !isdigit((int)b[ib])) ib++;
    if (va != vb) return (va < vb) ? -1 : 1;
  }
  return 0; // equal
}

// OTA helpers (GitHub Releases)
static String httpGet(const String& url) {
  WiFiClientSecure client;
  client.setInsecure(); // NOTE: For production, pin the certificate
  HTTPClient https;
  if (!https.begin(client, url)) return String();
  https.addHeader("User-Agent", "ReptiMon-OTA");
  // Hint GitHub to return JSON (not strictly required, but more future-proof)
  https.addHeader("Accept", "application/vnd.github+json");
  // Optional Authorization to bypass low anonymous rate limits
  if (GITHUB_TOKEN[0] != '\0') {
    https.addHeader("Authorization", String("Bearer ") + GITHUB_TOKEN);
  }
  int code = https.GET();
  if (code != HTTP_CODE_OK) { https.end(); return String(); }
  String body = https.getString();
  https.end();
  return body;
}

// New: supports prereleases and returns both firmware and filesystem URLs
static bool getGithubLatest(String& outTag, String& outFwUrl, String& outFsUrl, String& outReleasePage, String& outPublished) {
  String base = String("https://api.github.com/repos/") + kGithubOwner + "/" + kGithubRepo + "/releases";
  auto parseRelease = [&](JsonVariant v)->bool{
    if (!v.is<JsonObject>()) return false;
    const char* tagC = v["tag_name"].is<const char*>() ? v["tag_name"].as<const char*>() : "";
    const char* pageC = v["html_url"].is<const char*>() ? v["html_url"].as<const char*>() : "";
    const char* pubC  = v["published_at"].is<const char*>() ? v["published_at"].as<const char*>() : "";
    outTag = String(tagC);
    outReleasePage = String(pageC);
    outPublished = String(pubC);
    outFwUrl = ""; outFsUrl = "";
    JsonArray assets = v["assets"].as<JsonArray>();
    if (!assets.isNull()) {
      for (JsonVariant a : assets) {
        const char* name = a["name"].is<const char*>() ? a["name"].as<const char*>() : "";
        const char* dl   = a["browser_download_url"].is<const char*>() ? a["browser_download_url"].as<const char*>() : "";
        if (!name || !dl || !*dl) continue;
        if (strcmp(name, kGithubAsset) == 0) outFwUrl = String(dl);
        if (strcmp(name, GITHUB_FS_ASSET_NAME) == 0) outFsUrl = String(dl);
      }
    }
    return outTag.length() && outFwUrl.length();
  };
  // 1) /latest (published releases)
  String latestJson = httpGet(base + "/latest");
  if (latestJson.length()) {
    DynamicJsonDocument d(32768);
    if (!deserializeJson(d, latestJson)) {
      if (parseRelease(d.as<JsonVariant>())) return true;
    }
  }
  // 2) Fallback to releases list (includes prereleases)
  String listJson = httpGet(base);
  if (!listJson.length()) return false;
  DynamicJsonDocument arr(65536);
  if (deserializeJson(arr, listJson)) return false;
  if (!arr.is<JsonArray>()) return false;
  for (JsonVariant r : arr.as<JsonArray>()) {
    if (parseRelease(r)) return true; // GitHub returns newest first
  }
  return false;
}

static bool applyOtaFromUrl(const String& url, String& outMsg) {
  if (otaInProgress) { outMsg = "OTA in progress"; return false; }
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  if (!https.begin(client, url)) { outMsg = "begin failed"; return false; }
  https.addHeader("User-Agent", "ReptiMon-OTA");
  https.addHeader("Accept", "application/octet-stream");
  if (GITHUB_TOKEN[0] != '\0') {
    https.addHeader("Authorization", String("Bearer ") + GITHUB_TOKEN);
  }
  int code = https.GET();
  if (code != HTTP_CODE_OK) { outMsg = String("HTTP ") + code; https.end(); return false; }
  int len = https.getSize();
  if (len <= 0) { outMsg = "invalid size"; https.end(); return false; }
  if (!Update.begin(len)) { outMsg = "Update.begin failed"; https.end(); return false; }
  otaInProgress = true;
  WiFiClient* stream = https.getStreamPtr();
  size_t written = Update.writeStream(*stream);
  bool ok = (written == (size_t)len) && Update.end();
  https.end();
  otaInProgress = false;
  if (!ok) { outMsg = String("Update failed: ") + (Update.getError()); return false; }
  outMsg = "OK";
  return true;
}

// Filesystem OTA (LittleFS image)
static bool applyFsOtaFromUrl(const String& url, String& outMsg) {
  if (otaInProgress) { outMsg = "OTA in progress"; return false; }
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  if (!https.begin(client, url)) { outMsg = "begin failed"; return false; }
  https.addHeader("User-Agent", "ReptiMon-OTA");
  https.addHeader("Accept", "application/octet-stream");
  if (GITHUB_TOKEN[0] != '\0') {
    https.addHeader("Authorization", String("Bearer ") + GITHUB_TOKEN);
  }
  int code = https.GET();
  if (code != HTTP_CODE_OK) { outMsg = String("HTTP ") + code; https.end(); return false; }
  int len = https.getSize();
  if (len <= 0) { outMsg = "invalid size"; https.end(); return false; }
  if (!Update.begin(len, U_SPIFFS)) { outMsg = "Update.begin(U_SPIFFS) failed"; https.end(); return false; }
  otaInProgress = true;
  WiFiClient* stream = https.getStreamPtr();
  size_t written = Update.writeStream(*stream);
  bool ok = (written == (size_t)len) && Update.end();
  https.end();
  otaInProgress = false;
  if (!ok) { outMsg = String("FS Update failed: ") + (Update.getError()); return false; }
  outMsg = "OK";
  return true;
}

// XIAO ESP32S3 + OV2640 default pinout (common AI-Thinker compatible)
// Adjust if your breakout differs
#ifndef PWDN_GPIO_NUM
#define PWDN_GPIO_NUM    -1
#endif
#ifndef RESET_GPIO_NUM
#define RESET_GPIO_NUM   -1
#endif
#ifndef XCLK_GPIO_NUM
#define XCLK_GPIO_NUM    10
#endif
#ifndef SIOD_GPIO_NUM
#define SIOD_GPIO_NUM    40
#endif
#ifndef SIOC_GPIO_NUM
#define SIOC_GPIO_NUM    39
#endif

#ifndef Y9_GPIO_NUM
#define Y9_GPIO_NUM      48
#endif
#ifndef Y8_GPIO_NUM
#define Y8_GPIO_NUM      11
#endif
#ifndef Y7_GPIO_NUM
#define Y7_GPIO_NUM      12
#endif
#ifndef Y6_GPIO_NUM
#define Y6_GPIO_NUM      14
#endif
#ifndef Y5_GPIO_NUM
#define Y5_GPIO_NUM      16
#endif
#ifndef Y4_GPIO_NUM
#define Y4_GPIO_NUM      18
#endif
#ifndef Y3_GPIO_NUM
#define Y3_GPIO_NUM      17
#endif
#ifndef Y2_GPIO_NUM
#define Y2_GPIO_NUM      15
#endif
#ifndef VSYNC_GPIO_NUM
#define VSYNC_GPIO_NUM   38
#endif
#ifndef HREF_GPIO_NUM
#define HREF_GPIO_NUM    47
#endif
#ifndef PCLK_GPIO_NUM
#define PCLK_GPIO_NUM    13
#endif

bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  // Use non-deprecated SCCB pin fields
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // Frame size and quality from settings
  config.frame_size = (framesize_t)appSettings.camFrameSize; // e.g., FRAMESIZE_QVGA
  config.jpeg_quality = appSettings.camQuality;              // 10-63
  // Use double buffer and grab latest for smoother real-time preview
  config.fb_count = 2;
  config.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    cameraAvailable = false;
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, (framesize_t)appSettings.camFrameSize);
    s->set_quality(s, appSettings.camQuality);
    // Sensible defaults for OV2640 image quality
    s->set_whitebal(s, 1);       // enable auto white balance
    s->set_awb_gain(s, 1);       // AWB gain enable
    s->set_wb_mode(s, 0);        // auto WB
    s->set_gain_ctrl(s, 1);      // auto gain control
    s->set_exposure_ctrl(s, 1);  // auto exposure control
    s->set_aec2(s, 1);           // improved AEC algorithm
    s->set_gainceiling(s, GAINCEILING_64X); // allow higher gain in low light
    s->set_lenc(s, 1);           // lens correction to reduce color shading
    s->set_bpc(s, 1);            // black pixel correction
    s->set_wpc(s, 1);            // white pixel correction
    s->set_dcw(s, 1);            // downsize quality improve
    s->set_brightness(s, 1);     // -2..2 (slight lift)
    s->set_contrast(s, 0);       // -2..2
    s->set_saturation(s, 1);     // -2..2 (slight boost)
    s->set_special_effect(s, 0); // none
    s->set_colorbar(s, 0);       // disable test pattern
    // Optional flips depending on mounting
    // s->set_hmirror(s, 1);
    // s->set_vflip(s, 1);
  }
  cameraAvailable = true;
  Serial.println("Camera initialized successfully");
  return true;
}

// MJPEG streaming response for AsyncWebServer
class AsyncJpegStreamResponse : public AsyncAbstractResponse {
public:
  AsyncJpegStreamResponse() {
    _code = 200;
    _contentType = String("multipart/x-mixed-replace; boundary=") + _boundary;
    _sendContentLength = false;
    _chunked = true;
    _fb = nullptr;
    _index = 0;
    _state = State::HEADER;
    _locked = false;
  }
  ~AsyncJpegStreamResponse() override {
    if (_fb) { esp_camera_fb_return(_fb); _fb = nullptr; }
    if (_locked && cameraMutex) { xSemaphoreGive(cameraMutex); _locked = false; }
  }
  bool _sourceValid() const override { return true; }
  size_t _fillBuffer(uint8_t *buf, size_t maxLen) override {
    size_t len = 0;
    while (len < maxLen) {
      if (_state == State::HEADER) {
        if (_fb) { esp_camera_fb_return(_fb); _fb = nullptr; }
        if (cameraMutex && !_locked) { xSemaphoreTake(cameraMutex, portMAX_DELAY); _locked = true; }
        _fb = esp_camera_fb_get();
        if (!_fb) { return len; }
        _index = 0;
        // Prepare part header
        _header = String("--") + _boundary + "\r\n";
        _header += "Content-Type: image/jpeg\r\n";
        _header += "Content-Length: " + String(_fb->len) + "\r\n\r\n";
        _headerSent = 0;
        _state = State::SEND_HEADER;
      }
      if (_state == State::SEND_HEADER) {
        size_t remaining = _header.length() - _headerSent;
        if (remaining > 0) {
          size_t toCopy = std::min(remaining, maxLen - len);
          memcpy(buf + len, _header.c_str() + _headerSent, toCopy);
          _headerSent += toCopy;
          len += toCopy;
          if (len >= maxLen) break;
        }
        if (_headerSent >= _header.length()) {
          _state = State::SEND_FRAME;
        } else {
          break;
        }
      }
      if (_state == State::SEND_FRAME) {
        size_t remaining = _fb->len - _index;
        if (remaining > 0) {
          size_t toCopy = std::min(remaining, maxLen - len);
          memcpy(buf + len, _fb->buf + _index, toCopy);
          _index += toCopy;
          len += toCopy;
          if (len >= maxLen) break;
        }
        if (_index >= _fb->len) {
          _state = State::SEND_TAIL;
        } else {
          break;
        }
      }
      if (_state == State::SEND_TAIL) {
        const char *tail = "\r\n";
        size_t remaining = 2 - _tailSent;
        if (remaining > 0) {
          size_t toCopy = std::min(remaining, maxLen - len);
          memcpy(buf + len, tail + _tailSent, toCopy);
          _tailSent += toCopy;
          len += toCopy;
          if (len >= maxLen) break;
        }
        if (_tailSent >= 2) {
          _tailSent = 0;
          // Completed a frame; update global stream stats
          if (_fb) { camStatFrames++; camStatBytes += _fb->len; }
          if (_locked && cameraMutex) { xSemaphoreGive(cameraMutex); _locked = false; }
          _state = State::HEADER; // next frame
        } else {
          break;
        }
      }
    }
    return len;
  }
private:
  enum class State { HEADER, SEND_HEADER, SEND_FRAME, SEND_TAIL };
  const char* _boundary = "frame";
  camera_fb_t *_fb;
  size_t _index;
  State _state;
  String _header;
  size_t _headerSent = 0;
  size_t _tailSent = 0;
  bool _locked = false;
};

// Optimized calculation functions using fast math
inline float calculateDewPoint(float temp, float humidity) {
  const float a = 17.27f;
  const float b = 237.7f;
  float alpha = ((a * temp) / (b + temp)) + logf(humidity * 0.01f);
  return (b * alpha) / (a - alpha);
}

inline float calculateHeatIndex(float temp, float humidity) {
  if (temp < 27.0f) return temp;
  return 0.5f * (temp + 61.0f + ((temp - 68.0f) * 1.2f) + (humidity * 0.094f));
}

inline float calculateVPD(float temp, float humidity) {
  float es = 0.6108f * expf((17.27f * temp) / (temp + 237.3f));
  float ea = es * humidity * 0.01f;
  return es - ea;
}

inline float calculateAbsoluteHumidity(float temp, float humidity) {
  float es = 0.6108f * expf((17.27f * temp) / (temp + 237.3f));
  float ea = es * humidity * 0.01f;
  return (ea * 2.16679f) / (temp + 273.15f);
}

String getTemperatureStatus(float tempC) {
  // Sensor temperature is in °C; thresholds may be saved in user units (°F or °C).
  float tMinC = thresholds.tempMin;
  float tMaxC = thresholds.tempMax;
  float tIdealC = thresholds.tempIdeal;
  if (appSettings.units == "F") {
    auto f2c = [](float f){ return (f - 32.0f) * 5.0f / 9.0f; };
    tMinC = f2c(thresholds.tempMin);
    tMaxC = f2c(thresholds.tempMax);
    tIdealC = f2c(thresholds.tempIdeal);
  }
  if (tempC < tMinC) return "Too Cold";
  if (tempC > tMaxC) return "Too Hot";
  // In range [min, max] is Perfect per request
  return "Perfect";
}

String getHumidityStatus(float humidity) {
  if (humidity < thresholds.humMin) return "Too Dry";
  if (humidity > thresholds.humMax) return "Too Wet";
  // In range [min, max] is Perfect per request
  return "Perfect";
}

void loadAppSettings() {
  appPrefs.begin("app", true);
  appSettings.hostname = appPrefs.getString("host", appSettings.hostname);
  appSettings.units = appPrefs.getString("units", appSettings.units);
  appSettings.tempMin = appPrefs.getFloat("tmin", thresholds.tempMin);
  appSettings.tempMax = appPrefs.getFloat("tmax", thresholds.tempMax);
  appSettings.tempIdeal = appPrefs.getFloat("tideal", thresholds.tempIdeal);
  appSettings.humMin = appPrefs.getFloat("hmin", thresholds.humMin);
  appSettings.humMax = appPrefs.getFloat("hmax", thresholds.humMax);
  appSettings.humIdeal = appPrefs.getFloat("hideal", thresholds.humIdeal);
  appSettings.comfortMin = appPrefs.getFloat("cmin", thresholds.comfortMin);
  appSettings.comfortMax = appPrefs.getFloat("cmax", thresholds.comfortMax);
  appSettings.comfortIdeal = appPrefs.getFloat("cideal", thresholds.comfortIdeal);
  appSettings.camFrameSize = appPrefs.getInt("camsize", appSettings.camFrameSize);
  appSettings.camQuality = appPrefs.getInt("camq", appSettings.camQuality);
  appPrefs.end();

  // Apply to runtime thresholds and hostname
  thresholds.tempMin = appSettings.tempMin;
  thresholds.tempMax = appSettings.tempMax;
  thresholds.tempIdeal = appSettings.tempIdeal;
  thresholds.humMin = appSettings.humMin;
  thresholds.humMax = appSettings.humMax;
  thresholds.humIdeal = appSettings.humIdeal;
  thresholds.comfortMin = appSettings.comfortMin;
  thresholds.comfortMax = appSettings.comfortMax;
  thresholds.comfortIdeal = appSettings.comfortIdeal;
  mdnsHostname = appSettings.hostname.length() ? appSettings.hostname : String("momo");
}

void saveAppSettings(const AppSettings &s) {
  appPrefs.begin("app", false);
  appPrefs.putString("host", s.hostname);
  appPrefs.putString("units", s.units);
  appPrefs.putFloat("tmin", s.tempMin);
  appPrefs.putFloat("tmax", s.tempMax);
  appPrefs.putFloat("tideal", s.tempIdeal);
  appPrefs.putFloat("hmin", s.humMin);
  appPrefs.putFloat("hmax", s.humMax);
  appPrefs.putFloat("hideal", s.humIdeal);
  appPrefs.putFloat("cmin", s.comfortMin);
  appPrefs.putFloat("cmax", s.comfortMax);
  appPrefs.putFloat("cideal", s.comfortIdeal);
  appPrefs.putInt("camsize", s.camFrameSize);
  appPrefs.putInt("camq", s.camQuality);
  appPrefs.end();
}

void updateStatisticsAtomic(float temp, float humidity, float dewPoint) {
  if (!stats.initialized) {
    stats.tempMin = stats.tempMax = stats.tempAvg = temp;
    stats.humMin = stats.humMax = stats.humAvg = humidity;
    stats.dewMin = stats.dewMax = stats.dewAvg = dewPoint;
    stats.readingCount = 1;
    stats.initialized = true;
    return;
  }
  
  stats.readingCount++;
  float n = stats.readingCount;
  
  // Update averages with exponential smoothing for better performance
  stats.tempAvg = ((n-1) * stats.tempAvg + temp) / n;
  stats.humAvg = ((n-1) * stats.humAvg + humidity) / n;
  stats.dewAvg = ((n-1) * stats.dewAvg + dewPoint) / n;
  
  // Update min/max
  if (temp < stats.tempMin) stats.tempMin = temp;
  if (temp > stats.tempMax) stats.tempMax = temp;
  if (humidity < stats.humMin) stats.humMin = humidity;
  if (humidity > stats.humMax) stats.humMax = humidity;
  if (dewPoint < stats.dewMin) stats.dewMin = dewPoint;
  if (dewPoint > stats.dewMax) stats.dewMax = dewPoint;
}

void updateLEDStatusFast(float temp, float humidity) {
  bool tempOK = (temp >= thresholds.tempMin && temp <= thresholds.tempMax);
  bool humOK = (humidity >= thresholds.humMin && humidity <= thresholds.humMax);
  
  if (tempOK && humOK) {
    digitalWrite(LED_BUILTIN_RED, LOW);   // Turn off red (no alert)
    digitalWrite(LED_BUILTIN_BLUE, HIGH); // Turn on blue (all good)
  } else {
    digitalWrite(LED_BUILTIN_RED, HIGH);  // Turn on red (alert)
    digitalWrite(LED_BUILTIN_BLUE, LOW);  // Turn off blue
  }
}

void printUltraFastReading(EnvironmentData &data) {
  Serial.printf("Temp %.2f°C  RH %.1f%%  DewPt %.1f°C  HeatIdx %.1f°C  VPD %.2f kPa  AbsHum %.2f g/m³\n",
                data.temperature, data.humidity, data.dewPoint, 
                data.heatIndex, data.vaporPressureDeficit, data.absoluteHumidity);
}

void setupWiFi() {
  // Load app settings to get hostname and thresholds before network init
  loadAppSettings();
  // Load stored credentials (if any)
  preferences.begin("wifi", true);
  String storedSSID = preferences.getString("ssid", "");
  String storedPASS = preferences.getString("pass", "");
  preferences.end();

  if (storedSSID.length() == 0) {
    // No stored credentials: start AP mode with captive portal
    uint64_t chipid = ESP.getEfuseMac();
    char idbuf[7];
    sprintf(idbuf, "%06X", (uint32_t)(chipid & 0xFFFFFF));
  ap_ssid_dyn = String("ReptiMon-") + idbuf;
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
    WiFi.softAP(ap_ssid_dyn.c_str(), ap_password, 6 /*channel*/, 0 /*hidden*/, 4 /*max conn*/);
    useAccessPoint = true;
    captivePortalActive = true;
    dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
  Serial.println("\nAccess Point Mode Active");
    Serial.println("===================================================================");
  Serial.print("Network: ");
    Serial.println(ap_ssid_dyn);
  Serial.print("Password: ");
    Serial.println(ap_password);
  Serial.print("IP address: ");
    Serial.println(WiFi.softAPIP());
  Serial.println("Connect your device to this network and open: " + WiFi.softAPIP().toString());
    Serial.println("===================================================================");
    return;
  }
  
  // Use stored credentials
  selectedSSID = storedSSID;
  selectedPassword = storedPASS;
  WiFi.mode(WIFI_STA);
  if (selectedPassword.length() == 0) {
    WiFi.begin(selectedSSID.c_str());
  } else {
    WiFi.begin(selectedSSID.c_str(), selectedPassword.c_str());
  }
  
  Serial.print("Connecting to '" + selectedSSID + "'");
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
  Serial.println("\nWiFi connected successfully.");
    Serial.println("===================================================================");
  Serial.print("Network: ");
  Serial.println(selectedSSID);
  Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
  Serial.print("Signal strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  Serial.print("Gateway: ");
    Serial.println(WiFi.gatewayIP());
  Serial.print("Subnet: ");
    Serial.println(WiFi.subnetMask());
    Serial.println("===================================================================");
  Serial.println("Web interface ready. Open your browser and go to: " + WiFi.localIP().toString());
  Serial.println("Access from any device on your network.");
    Serial.println("===================================================================");
    // Stop AP/captive DNS if previously active
    if (useAccessPoint) {
      dnsServer.stop();
      captivePortalActive = false;
      WiFi.softAPdisconnect(true);
      useAccessPoint = false;
    }
    // Start mDNS for easy discovery when connected to WiFi
    mdnsActive = MDNS.begin(mdnsHostname.c_str());
    if (mdnsActive) {
      MDNS.addService("http", "tcp", 80);
      Serial.printf("mDNS active: http://%s.local\n", mdnsHostname.c_str());
    } else {
      Serial.println("mDNS failed to start");
    }
  } else {
  Serial.println("\nWiFi connection failed.");
  Serial.println("Creating Access Point instead...");
    uint64_t chipid = ESP.getEfuseMac();
    char idbuf[7];
    sprintf(idbuf, "%06X", (uint32_t)(chipid & 0xFFFFFF));
  ap_ssid_dyn = String("ReptiMon-") + idbuf;
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
    WiFi.softAP(ap_ssid_dyn.c_str(), ap_password, 6 /*channel*/, 0 /*hidden*/, 4 /*max conn*/);
    useAccessPoint = true;
    captivePortalActive = true;
    dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
  Serial.println("AP IP address: " + WiFi.softAPIP().toString());
  Serial.println("Connect to '" + ap_ssid_dyn + "' and open: " + WiFi.softAPIP().toString());
  }
}

String generateJsonData() {
  DynamicJsonDocument doc(1024);
  
  // Current readings
  float tempDisplay = currentData.temperature;
  if (appSettings.units == "F") {
    tempDisplay = currentData.temperature * 9.0f / 5.0f + 32.0f;
  }
  doc["temperature"] = tempDisplay;
  doc["humidity"] = currentData.humidity;
  float dewDisplay = currentData.dewPoint;
  float heatIdxDisplay = currentData.heatIndex;
  if (appSettings.units == "F") {
    dewDisplay = currentData.dewPoint * 9.0f / 5.0f + 32.0f;
    heatIdxDisplay = currentData.heatIndex * 9.0f / 5.0f + 32.0f;
  }
  doc["dewPoint"] = dewDisplay;
  doc["heatIndex"] = heatIdxDisplay;
  doc["vpd"] = currentData.vaporPressureDeficit;
  doc["absoluteHumidity"] = currentData.absoluteHumidity;
  doc["timestamp"] = currentData.timestamp;
  doc["valid"] = currentData.valid;
  
  // Status indicators
  doc["tempStatus"] = getTemperatureStatus(currentData.temperature);
  doc["humStatus"] = getHumidityStatus(currentData.humidity);
  doc["units"] = appSettings.units;
  
  // Thresholds
  JsonObject thresh = doc.createNestedObject("thresholds");
  thresh["tempMin"] = thresholds.tempMin;
  thresh["tempMax"] = thresholds.tempMax;
  thresh["tempIdeal"] = thresholds.tempIdeal;
  thresh["humMin"] = thresholds.humMin;
  thresh["humMax"] = thresholds.humMax;
  thresh["humIdeal"] = thresholds.humIdeal;
  thresh["comfortMin"] = thresholds.comfortMin;
  thresh["comfortMax"] = thresholds.comfortMax;
  thresh["comfortIdeal"] = thresholds.comfortIdeal;
  
  // Statistics
  if (stats.initialized) {
    JsonObject st = doc.createNestedObject("stats");
    st["tempMin"] = stats.tempMin;
    st["tempMax"] = stats.tempMax;
    st["tempAvg"] = stats.tempAvg;
    st["humMin"] = stats.humMin;
    st["humMax"] = stats.humMax;
    st["humAvg"] = stats.humAvg;
    st["dewMin"] = stats.dewMin;
    st["dewMax"] = stats.dewMax;
    st["dewAvg"] = stats.dewAvg;
    st["readingCount"] = stats.readingCount;
  }
  
  // System info
  JsonObject sys = doc.createNestedObject("system");
  sys["uptime"] = millis();
  sys["freeHeap"] = ESP.getFreeHeap();
  // Total heap size (bytes)
  #ifdef ESP_ARDUINO_VERSION
  sys["heapSize"] = ESP.getHeapSize();
  #endif
  sys["cpuFreq"] = getCpuFrequencyMhz();
  sys["sensorHz"] = sensorReadCount * 1000.0f / millis();
  sys["displayHz"] = displayUpdateCount * 1000.0f / millis();
  sys["camera"] = cameraAvailable;
  sys["rssi"] = (WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  sys["ip"] = (WiFi.getMode() == WIFI_AP) ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  sys["hostname"] = mdnsHostname;
  sys["mdns"] = mdnsActive;
  // WiFi mode/connection flags
  wifi_mode_t mode = WiFi.getMode();
  const char* modeStr = (mode == WIFI_OFF) ? "off" : (mode == WIFI_STA) ? "sta" : (mode == WIFI_AP) ? "ap" : (mode == WIFI_AP_STA) ? "ap+sta" : "unknown";
  sys["wifiMode"] = modeStr;
  sys["sta"] = (WiFi.status() == WL_CONNECTED);
  sys["ap"] = (mode == WIFI_AP) || (mode == WIFI_AP_STA);
  // PSRAM (bytes)
  sys["psramSize"] = ESP.getPsramSize();
  sys["freePsram"] = ESP.getFreePsram();
  // Flash & sketch (bytes)
  sys["flashSize"] = ESP.getFlashChipSize();
  sys["flashSpeed"] = ESP.getFlashChipSpeed();
  sys["sketchSize"] = ESP.getSketchSize();
  sys["freeSketch"] = ESP.getFreeSketchSpace();
  // LittleFS usage (bytes)
  sys["fwVersion"] = fwVersion;
  sys["fwCommit"] = fwCommit;
  sys["fwBuilt"] = fwBuild;
  sys["fsTotal"] = LittleFS.totalBytes();
  sys["fsUsed"] = LittleFS.usedBytes();
  // Identity
  sys["sdk"] = String(ESP.getSdkVersion());
  #ifdef ARDUINO_ARCH_ESP32
  sys["chipModel"] = String(ESP.getChipModel());
  sys["chipRev"] = ESP.getChipRevision();
  #endif
  // MAC addresses
  sys["macSta"] = WiFi.macAddress();
  sys["macAp"] = WiFi.softAPmacAddress();
  // Convenience fields: prefer STA SSID when connected; else show AP SSID if AP mode is active
  {
    wl_status_t st = WiFi.status();
    wifi_mode_t mode = WiFi.getMode();
    bool apActive = (mode == WIFI_AP) || (mode == WIFI_AP_STA);
    if (st == WL_CONNECTED) {
      doc["ssid"] = selectedSSID;
    } else if (apActive) {
      doc["ssid"] = ap_ssid_dyn;
    } else {
      doc["ssid"] = "";
    }
  }
  
  String jsonString;
  serializeJson(doc, jsonString);
  return jsonString;
}

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type,
             void *arg, uint8_t *data, size_t len) {
  switch (type) {
    case WS_EVT_CONNECT:
  Serial.printf("WebSocket client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
      // Send current data immediately
      client->text(generateJsonData());
      break;
      
    case WS_EVT_DISCONNECT:
  Serial.printf("WebSocket client #%u disconnected\n", client->id());
      break;
      
    case WS_EVT_ERROR:
  Serial.printf("WebSocket error from client #%u\n", client->id());
      break;
      
    case WS_EVT_DATA: {
      // Handle incoming data if needed (e.g., threshold updates)
      AwsFrameInfo *info = (AwsFrameInfo*)arg;
      if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
        // Handle text messages here if needed
        String message = "";
        for (size_t i = 0; i < info->len; i++) {
          message += (char) data[i];
        }
  Serial.printf("WebSocket message: %s\n", message.c_str());
      }
      break;
    }
  }
}

void setupWebServer() {
  // Initialize LittleFS for serving static files
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS initialization failed!");
    return;
  }
  Serial.println("LittleFS initialized successfully");
  
  // WebSocket handler
  ws.onEvent(onWsEvent);
  server.addHandler(&ws);
  
  // Serve static files from data folder
  // Route: if captive portal is active, default to portal.html at root; otherwise index.html
  auto defaultFileSelector = [](AsyncWebServerRequest *request){
    if (captivePortalActive) return String("/portal.html");
    return String("/index.html");
  };
  server.on("/", HTTP_GET, [defaultFileSelector](AsyncWebServerRequest *request){
    String path = defaultFileSelector(request);
    request->send(LittleFS, path, String(), false);
  });
  // Also expose explicit /portal and /index
  server.on("/portal", HTTP_GET, [](AsyncWebServerRequest *request){ request->send(LittleFS, "/portal.html", String(), false); });
  server.on("/index", HTTP_GET, [](AsyncWebServerRequest *request){ request->send(LittleFS, "/index.html", String(), false); });
  // Static assets under root
  // IMPORTANT: Disable cache for core SPA assets to avoid client-side mismatches after updates
  server.serveStatic("/index.html", LittleFS, "/index.html").setCacheControl("no-cache, no-store, must-revalidate");
  server.serveStatic("/script.js", LittleFS, "/script.js").setCacheControl("no-cache, no-store, must-revalidate");
  server.serveStatic("/style.css", LittleFS, "/style.css").setCacheControl("no-cache, no-store, must-revalidate");
  server.serveStatic("/components", LittleFS, "/components/").setCacheControl("no-cache, no-store, must-revalidate");
  server.serveStatic("/partials", LittleFS, "/partials/").setCacheControl("no-cache, no-store, must-revalidate");
  // Vendor and everything else can be cached for a while
  server.serveStatic("/vendor", LittleFS, "/vendor/").setCacheControl("public, max-age=86400");
  server.serveStatic("/", LittleFS, "/").setCacheControl("public, max-age=86400");

  // API endpoint for JSON data
  server.on("/api/data", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "application/json", generateJsonData());
  });

  // WiFi status endpoint
  server.on("/api/wifi/status", HTTP_GET, [](AsyncWebServerRequest *request) {
    DynamicJsonDocument doc(512);
    bool ap = (WiFi.getMode() == WIFI_AP);
    wl_status_t st = WiFi.status();
    const char* state = ap ? "ap" : (st == WL_CONNECTED ? "connected" : (wifiConnectPending ? "connecting" : "disconnected"));
    doc["state"] = state;
    doc["ssid"] = (st == WL_CONNECTED) ? selectedSSID : "";
    doc["ip"] = ap ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
    doc["rssi"] = (st == WL_CONNECTED) ? WiFi.RSSI() : 0;
    doc["hostname"] = mdnsHostname;
    doc["ap"] = ap;
    doc["connecting"] = wifiConnectPending;
    doc["sta_status"] = (int)st;
    if (ap) {
      doc["ap_ssid"] = ap_ssid_dyn;
      doc["captive"] = captivePortalActive;
    }
    // Scan status
    int sc = WiFi.scanComplete();
    if (sc == -1) doc["scan"] = "scanning"; else if (sc >= 0) doc["scan"] = "done"; else doc["scan"] = "idle";
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  // Detailed WiFi info (STA/AP details, MACs, DNS, gateway, subnet, BSSID, channel, tx power, sleep)
  server.on("/api/wifi/info", HTTP_GET, [](AsyncWebServerRequest *request) {
    DynamicJsonDocument doc(1024);
    bool ap = (WiFi.getMode() == WIFI_AP) || (WiFi.getMode() == WIFI_AP_STA);
    bool staEnabled = (WiFi.getMode() == WIFI_STA) || (WiFi.getMode() == WIFI_AP_STA);
    wl_status_t st = WiFi.status();
    doc["mode"] = (WiFi.getMode() == WIFI_AP) ? "ap" : (WiFi.getMode() == WIFI_STA) ? "sta" : (WiFi.getMode() == WIFI_AP_STA) ? "ap+sta" : "off";
    doc["state"] = (st == WL_CONNECTED) ? "connected" : (wifiConnectPending ? "connecting" : (ap ? "ap" : "disconnected"));
    doc["hostname"] = mdnsHostname;
  doc["mdns"] = mdnsActive;
    // STA details
    JsonObject sta = doc.createNestedObject("sta");
    sta["enabled"] = staEnabled;
    sta["ssid"] = (st == WL_CONNECTED) ? selectedSSID : "";
    sta["bssid"] = (st == WL_CONNECTED) ? WiFi.BSSIDstr() : "";
    sta["rssi"] = (st == WL_CONNECTED) ? WiFi.RSSI() : 0;
    sta["channel"] = (st == WL_CONNECTED) ? WiFi.channel() : 0;
    sta["ip"] = WiFi.localIP().toString();
    sta["gateway"] = WiFi.gatewayIP().toString();
    sta["subnet"] = WiFi.subnetMask().toString();
    sta["dns"] = WiFi.dnsIP().toString();
    sta["mac"] = WiFi.macAddress();
    // AP details
    JsonObject apj = doc.createNestedObject("ap");
    apj["enabled"] = ap;
    apj["ssid"] = useAccessPoint ? ap_ssid_dyn : WiFi.softAPSSID();
    apj["ip"] = WiFi.softAPIP().toString();
    apj["mac"] = WiFi.softAPmacAddress();
    apj["clients"] = WiFi.softAPgetStationNum();
    apj["captive"] = captivePortalActive;
    // Radio
    JsonObject radio = doc.createNestedObject("radio");
    auto txEnum = WiFi.getTxPower();
    auto enumToDbm = [](wifi_power_t p)->int{
      switch(p){
        case WIFI_POWER_19_5dBm: return 20;
        case WIFI_POWER_19dBm: return 19;
        case WIFI_POWER_18_5dBm: return 18;
        case WIFI_POWER_17dBm: return 17;
        case WIFI_POWER_15dBm: return 15;
        case WIFI_POWER_13dBm: return 13;
        case WIFI_POWER_11dBm: return 11;
        case WIFI_POWER_8_5dBm: return 9;
        case WIFI_POWER_7dBm: return 7;
        case WIFI_POWER_5dBm: return 5;
        case WIFI_POWER_2dBm: return 2;
        default: return 0;
      }
    };
    radio["tx_power_dbm"] = enumToDbm(txEnum);
    radio["sleep"] = WiFi.getSleep();
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  // WiFi scan start (non-blocking)
  server.on("/api/wifi/scan/start", HTTP_GET, [](AsyncWebServerRequest *request) {
    // If AP is active, keep it and add STA; otherwise just STA
    if (useAccessPoint) {
      WiFi.mode(WIFI_AP_STA);
    } else {
      WiFi.mode(WIFI_STA);
    }
    WiFi.scanDelete();
    int r = WiFi.scanNetworks(true /* async */, true /* show_hidden */);
    DynamicJsonDocument doc(256);
    doc["status"] = (r == -1) ? "started" : "failed";
    String out; serializeJson(doc, out);
    request->send(202, "application/json", out);
  });

  // WiFi scan results
  server.on("/api/wifi/scan/results", HTTP_GET, [](AsyncWebServerRequest *request) {
    DynamicJsonDocument doc(4096);
    int sc = WiFi.scanComplete();
    if (sc == -1) {
      doc["status"] = "scanning";
    } else if (sc == -2) {
      doc["status"] = "failed";
    } else {
      doc["status"] = "done";
      JsonArray arr = doc.createNestedArray("networks");
      for (int i = 0; i < sc; i++) {
        JsonObject o = arr.createNestedObject();
        o["ssid"] = WiFi.SSID(i);
        o["rssi"] = WiFi.RSSI(i);
        o["security"] = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "open" : "secured";
        o["channel"] = WiFi.channel(i);
      }
      WiFi.scanDelete();
    }
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  // WiFi connect endpoint (non-blocking start)
  server.on("/api/wifi/connect", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
    DynamicJsonDocument body(512);
    DeserializationError err = deserializeJson(body, data, len);
    if (err) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    String ssid = body["ssid"] | "";
    String pass = body["password"] | "";
    if (ssid.length() == 0) { request->send(400, "application/json", "{\"error\":\"missing_ssid\"}"); return; }
    pendingSSID = ssid;
    pendingPass = pass;
    if (useAccessPoint) {
      WiFi.mode(WIFI_AP_STA);
    } else {
      WiFi.mode(WIFI_STA);
    }
  // Reset previous connection state before connecting
  WiFi.disconnect(true, true);
  delay(50);
  if (pass.length() == 0) WiFi.begin(ssid.c_str()); else WiFi.begin(ssid.c_str(), pass.c_str());
    wifiConnectPending = true;
    wifiConnectStart = millis();
    DynamicJsonDocument resp(256);
    resp["status"] = "connecting";
    String out; serializeJson(resp, out);
    request->send(202, "application/json", out);
  });

  // WiFi reconnect
  server.on("/api/wifi/reconnect", HTTP_POST, [](AsyncWebServerRequest *request){
    bool ok = WiFi.reconnect();
    request->send(200, "application/json", String("{\"status\":\"") + (ok ? "ok" : "failed") + "\"}");
  });

  // WiFi disconnect
  server.on("/api/wifi/disconnect", HTTP_POST, [](AsyncWebServerRequest *request){
    WiFi.disconnect(true, true);
    request->send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // Toggle AP mode (enable/disable AP alongside STA)
  server.on("/api/wifi/toggle_ap", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    DynamicJsonDocument body(512);
    if (deserializeJson(body, data, len)) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    bool enable = body["enable"].as<bool>();
    int channel = body.containsKey("channel") ? body["channel"].as<int>() : 6;
    String pass = body.containsKey("password") ? (const char*)body["password"] : ap_password;
    if (enable) {
      if (WiFi.getMode() == WIFI_STA) WiFi.mode(WIFI_AP_STA); else WiFi.mode(WIFI_AP);
      if (ap_ssid_dyn.length() == 0) {
        uint64_t chipid = ESP.getEfuseMac(); char idbuf[7]; sprintf(idbuf, "%06X", (uint32_t)(chipid & 0xFFFFFF));
        ap_ssid_dyn = String("ReptiMon-") + idbuf;
      }
      WiFi.softAPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
      WiFi.softAP(ap_ssid_dyn.c_str(), pass.c_str(), channel, 0, 4);
      useAccessPoint = true;
    } else {
      WiFi.softAPdisconnect(true);
      useAccessPoint = false;
    }
    DynamicJsonDocument resp(256); resp["status"] = "ok"; String out; serializeJson(resp, out); request->send(200, "application/json", out);
  });

  // TX power get
  server.on("/api/wifi/txpower/get", HTTP_GET, [](AsyncWebServerRequest *request){
    auto txEnum = WiFi.getTxPower();
    auto enumToDbm = [](wifi_power_t p)->int{
      switch(p){
        case WIFI_POWER_19_5dBm: return 20;
        case WIFI_POWER_19dBm: return 19;
        case WIFI_POWER_18_5dBm: return 18;
        case WIFI_POWER_17dBm: return 17;
        case WIFI_POWER_15dBm: return 15;
        case WIFI_POWER_13dBm: return 13;
        case WIFI_POWER_11dBm: return 11;
        case WIFI_POWER_8_5dBm: return 9;
        case WIFI_POWER_7dBm: return 7;
        case WIFI_POWER_5dBm: return 5;
        case WIFI_POWER_2dBm: return 2;
        default: return 0;
      }
    };
    DynamicJsonDocument doc(128); doc["tx_power_dbm"] = enumToDbm(txEnum); String out; serializeJson(doc, out); request->send(200, "application/json", out);
  });

  // TX power set (expects integer enum value)
  server.on("/api/wifi/txpower/set", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    DynamicJsonDocument body(128); if (deserializeJson(body, data, len)) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    int dbm = body["value"].as<int>();
    auto dbmToEnum = [](int d)->wifi_power_t{
      if (d >= 20) return WIFI_POWER_19_5dBm;
      else if (d >= 19) return WIFI_POWER_19dBm;
      else if (d >= 18) return WIFI_POWER_18_5dBm;
      else if (d >= 17) return WIFI_POWER_17dBm;
      else if (d >= 15) return WIFI_POWER_15dBm;
      else if (d >= 13) return WIFI_POWER_13dBm;
      else if (d >= 11) return WIFI_POWER_11dBm;
      else if (d >= 9) return WIFI_POWER_8_5dBm;
      else if (d >= 7) return WIFI_POWER_7dBm;
      else if (d >= 5) return WIFI_POWER_5dBm;
      else if (d >= 2) return WIFI_POWER_2dBm;
      else return WIFI_POWER_2dBm;
    };
    WiFi.setTxPower(dbmToEnum(dbm));
    request->send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // Sleep get/set
  server.on("/api/wifi/sleep/get", HTTP_GET, [](AsyncWebServerRequest *request){ DynamicJsonDocument d(64); d["sleep"] = WiFi.getSleep(); String o; serializeJson(d,o); request->send(200, "application/json", o); });
  server.on("/api/wifi/sleep/set", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    DynamicJsonDocument b(64); if (deserializeJson(b,data,len)) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    bool en = b["enable"].as<bool>(); WiFi.setSleep(en); request->send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // Hostname set (also restarts mDNS)
  server.on("/api/wifi/hostname/set", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    DynamicJsonDocument b(256); if (deserializeJson(b,data,len)) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    String hn = b["hostname"] | ""; if (hn.length()==0) { request->send(400, "application/json", "{\"error\":\"missing_hostname\"}"); return; }
    AppSettings ns = appSettings; ns.hostname = hn; saveAppSettings(ns); appSettings = ns; loadAppSettings();
  if (mdnsActive) { MDNS.end(); mdnsActive = false; }
  mdnsActive = MDNS.begin(mdnsHostname.c_str()); if (mdnsActive) { MDNS.addService("http","tcp",80); }
    request->send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // mDNS restart
  server.on("/api/wifi/mdns/restart", HTTP_POST, [](AsyncWebServerRequest *request){
  if (mdnsActive) { MDNS.end(); mdnsActive = false; }
  bool ok = MDNS.begin(mdnsHostname.c_str()); if (ok) { MDNS.addService("http","tcp",80); mdnsActive = true; }
    request->send(200, "application/json", String("{\"status\":\"") + (ok?"ok":"failed") + "\"}");
  });

  // WiFi forget endpoint (clears saved credentials and restarts)
  server.on("/api/wifi/forget", HTTP_POST, [](AsyncWebServerRequest *request){
    preferences.begin("wifi", false);
    preferences.remove("ssid");
    preferences.remove("pass");
    preferences.end();
    request->send(200, "application/json", "{\"status\":\"ok\"}");
    // Give the response time to flush, then restart
  Serial.println("Forget WiFi requested - restarting into AP mode...");
    delay(200);
    ESP.restart();
  });

  // Captive portal helpers: respond to common OS connectivity checks
  auto sendPortal = [](AsyncWebServerRequest *request){
    // Always direct OS captive checks to root; root decides portal vs index
    request->send(200, "text/html", "<html><head><meta http-equiv='refresh' content='0; url=/'/></head><body>Redirecting...</body></html>");
  };
  server.on("/generate_204", HTTP_GET, sendPortal);   // Android
  server.on("/gen_204", HTTP_GET, sendPortal);         // Android alt
  server.on("/hotspot-detect.html", HTTP_GET, sendPortal); // iOS/macOS
  server.on("/ncsi.txt", HTTP_GET, sendPortal);        // Windows
  server.on("/connecttest.txt", HTTP_GET, sendPortal); // Windows alt
  server.on("/check_network_status.txt", HTTP_GET, sendPortal);
  
  // Handle 404: during captive portal, redirect everything to root (portal)
  server.onNotFound([](AsyncWebServerRequest *request) {
    if (captivePortalActive) {
      request->redirect("/");
    } else {
      request->send(404, "text/plain", "File not found");
    }
  });
  
  server.begin();
  Serial.println("Web server started.");
  Serial.println("Serving static files from LittleFS.");

  // Settings endpoints
  server.on("/api/settings/get", HTTP_GET, [](AsyncWebServerRequest *request) {
    DynamicJsonDocument doc(1024);
    doc["hostname"] = appSettings.hostname;
    doc["units"] = appSettings.units;
    JsonObject th = doc.createNestedObject("thresholds");
    th["tempMin"] = appSettings.tempMin;
    th["tempMax"] = appSettings.tempMax;
    th["tempIdeal"] = appSettings.tempIdeal;
    th["humMin"] = appSettings.humMin;
    th["humMax"] = appSettings.humMax;
    th["humIdeal"] = appSettings.humIdeal;
    th["comfortMin"] = appSettings.comfortMin;
    th["comfortMax"] = appSettings.comfortMax;
    th["comfortIdeal"] = appSettings.comfortIdeal;
    JsonObject cam = doc.createNestedObject("camera");
    cam["available"] = cameraAvailable;
    cam["frameSize"] = appSettings.camFrameSize;
    cam["quality"] = appSettings.camQuality;
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  server.on("/api/settings/save", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    DynamicJsonDocument body(1024);
    DeserializationError err = deserializeJson(body, data, len);
    if (err) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    AppSettings ns = appSettings;
    if (body.containsKey("hostname")) ns.hostname = (const char*)body["hostname"];
    if (body.containsKey("units")) ns.units = (const char*)body["units"];
    if (body.containsKey("thresholds")) {
      JsonObject th = body["thresholds"].as<JsonObject>();
      if (th.containsKey("tempMin")) ns.tempMin = th["tempMin"].as<float>();
      if (th.containsKey("tempMax")) ns.tempMax = th["tempMax"].as<float>();
      if (th.containsKey("tempIdeal")) ns.tempIdeal = th["tempIdeal"].as<float>();
      if (th.containsKey("humMin")) ns.humMin = th["humMin"].as<float>();
      if (th.containsKey("humMax")) ns.humMax = th["humMax"].as<float>();
      if (th.containsKey("humIdeal")) ns.humIdeal = th["humIdeal"].as<float>();
      if (th.containsKey("comfortMin")) ns.comfortMin = th["comfortMin"].as<float>();
      if (th.containsKey("comfortMax")) ns.comfortMax = th["comfortMax"].as<float>();
      if (th.containsKey("comfortIdeal")) ns.comfortIdeal = th["comfortIdeal"].as<float>();
    }
    if (body.containsKey("camera")) {
      JsonObject cam = body["camera"].as<JsonObject>();
      if (cam.containsKey("frameSize")) ns.camFrameSize = cam["frameSize"].as<int>();
      if (cam.containsKey("quality")) ns.camQuality = cam["quality"].as<int>();
    }
    // Persist and apply
    saveAppSettings(ns);
    appSettings = ns;
    loadAppSettings();
    // If camera already up and settings changed, try to apply
    if (cameraAvailable) {
      sensor_t *s = esp_camera_sensor_get();
      if (s) {
        s->set_framesize(s, (framesize_t)appSettings.camFrameSize);
        s->set_quality(s, appSettings.camQuality);
      }
    }
    DynamicJsonDocument resp(256);
    resp["status"] = "ok";
    String out; serializeJson(resp, out);
    request->send(200, "application/json", out);
  });

  // System operations
  server.on("/api/system/reboot", HTTP_POST, [](AsyncWebServerRequest *request){
    request->send(200, "application/json", "{\"status\":\"rebooting\"}");
    Serial.println("Reboot requested via API");
    delay(200);
    ESP.restart();
  });

  // Camera endpoints
  server.on("/api/camera/status", HTTP_GET, [](AsyncWebServerRequest *request){
    DynamicJsonDocument doc(256);
    doc["available"] = cameraAvailable;
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  server.on("/api/camera/snapshot", HTTP_GET, [](AsyncWebServerRequest *request){
    if (!cameraAvailable) { request->send(503, "application/json", "{\"error\":\"camera_unavailable\"}"); return; }
    if (cameraMutex) xSemaphoreTake(cameraMutex, portMAX_DELAY);
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { request->send(500, "application/json", "{\"error\":\"capture_failed\"}"); return; }
  // Use non-deprecated response API
  AsyncWebServerResponse *response = request->beginResponse(200, String("image/jpeg"), fb->buf, fb->len);
    response->addHeader("Cache-Control", "no-store");
    request->send(response);
    esp_camera_fb_return(fb);
    if (cameraMutex) xSemaphoreGive(cameraMutex);
  });

  server.on("/api/camera/stream", HTTP_GET, [](AsyncWebServerRequest *request){
    if (!cameraAvailable) { request->send(503, "application/json", "{\"error\":\"camera_unavailable\"}"); return; }
    AsyncJpegStreamResponse *response = new AsyncJpegStreamResponse();
    response->addHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    response->addHeader("Pragma", "no-cache");
    request->send(response);
  });

  server.on("/api/camera/restart", HTTP_POST, [](AsyncWebServerRequest *request){
    bool ok = true;
    if (cameraAvailable) {
      if (cameraMutex) xSemaphoreTake(cameraMutex, portMAX_DELAY);
      esp_camera_deinit();
      cameraAvailable = false;
      delay(100);
    }
    ok = initCamera();
    if (cameraMutex) xSemaphoreGive(cameraMutex);
    request->send(200, "application/json", String("{\"status\":\"") + (ok?"ok":"failed") + "\"}");
  });

  // Camera stream stats (global)
  server.on("/api/camera/stream_stats", HTTP_GET, [](AsyncWebServerRequest *request){
    DynamicJsonDocument doc(256);
    doc["frames"] = camStatFrames;
    doc["bytes"] = camStatBytes;
    doc["since"] = camStatStartMs;
    doc["now"] = millis();
    String out; serializeJson(doc, out); request->send(200, "application/json", out);
  });

  // Camera controls: adjust common OV2640 parameters at runtime
  server.on("/api/camera/ctrl", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    if (!cameraAvailable) { request->send(503, "application/json", "{\"error\":\"camera_unavailable\"}"); return; }
    DynamicJsonDocument body(512);
    if (deserializeJson(body, data, len)) { request->send(400, "application/json", "{\"error\":\"invalid_json\"}"); return; }
    if (cameraMutex) xSemaphoreTake(cameraMutex, portMAX_DELAY);
    sensor_t *s = esp_camera_sensor_get();
    bool ok = (s != nullptr);
    if (ok) {
      if (body.containsKey("wb_mode")) { s->set_wb_mode(s, body["wb_mode"].as<int>()); }
      if (body.containsKey("whitebal")) { s->set_whitebal(s, body["whitebal"].as<bool>()); }
      if (body.containsKey("awb_gain")) { s->set_awb_gain(s, body["awb_gain"].as<bool>()); }
      if (body.containsKey("brightness")) { s->set_brightness(s, body["brightness"].as<int>()); }
      if (body.containsKey("contrast")) { s->set_contrast(s, body["contrast"].as<int>()); }
      if (body.containsKey("saturation")) { s->set_saturation(s, body["saturation"].as<int>()); }
      if (body.containsKey("ae_level")) { s->set_ae_level(s, body["ae_level"].as<int>()); }
      if (body.containsKey("aec2")) { s->set_aec2(s, body["aec2"].as<bool>()); }
      if (body.containsKey("gainceiling")) {
        int gc = body["gainceiling"].as<int>();
        switch(gc){
          case 2: s->set_gainceiling(s, GAINCEILING_2X); break;
          case 4: s->set_gainceiling(s, GAINCEILING_4X); break;
          case 8: s->set_gainceiling(s, GAINCEILING_8X); break;
          case 16: s->set_gainceiling(s, GAINCEILING_16X); break;
          case 32: s->set_gainceiling(s, GAINCEILING_32X); break;
          case 64: s->set_gainceiling(s, GAINCEILING_64X); break;
          case 128: s->set_gainceiling(s, GAINCEILING_128X); break;
          default: break;
        }
      }
      if (body.containsKey("lenc")) { s->set_lenc(s, body["lenc"].as<bool>()); }
      if (body.containsKey("bpc")) { s->set_bpc(s, body["bpc"].as<bool>()); }
      if (body.containsKey("wpc")) { s->set_wpc(s, body["wpc"].as<bool>()); }
      if (body.containsKey("dcw")) { s->set_dcw(s, body["dcw"].as<bool>()); }
      if (body.containsKey("hmirror")) { s->set_hmirror(s, body["hmirror"].as<bool>()); }
      if (body.containsKey("vflip")) { s->set_vflip(s, body["vflip"].as<bool>()); }
      if (body.containsKey("special")) { s->set_special_effect(s, body["special"].as<int>()); }
      if (body.containsKey("colorbar")) { s->set_colorbar(s, body["colorbar"].as<bool>()); }
    }
    if (cameraMutex) xSemaphoreGive(cameraMutex);
    request->send(200, "application/json", ok ? "{\"status\":\"ok\"}" : "{\"status\":\"failed\"}");
  });

  // OTA: check latest release on GitHub (supports prereleases, returns FS availability)
  server.on("/api/ota/check", HTTP_GET, [](AsyncWebServerRequest *request){
    String tag, fwUrl, fsUrl, relPage, publishedAt;
    bool ok = getGithubLatest(tag, fwUrl, fsUrl, relPage, publishedAt);
    DynamicJsonDocument d(512);
    d["current"] = fwVersion;
    d["ok"] = ok;
    d["latest"] = ok ? tag : "";
    d["hasUpdate"] = ok ? (semverCompare(fwVersion, tag) < 0) : false;
    d["hasFs"] = ok ? (fsUrl.length() > 0) : false;
    String repo = String(kGithubOwner) + "/" + String(kGithubRepo);
    d["repo"] = repo;
    d["releaseUrl"] = relPage.length() ? relPage : String("https://github.com/") + repo + "/releases";
    d["publishedAt"] = publishedAt;
    String o; serializeJson(d, o);
    request->send(200, "application/json", o);
  });
  // OTA: apply update from latest release asset (firmware.bin)
  server.on("/api/ota/update", HTTP_POST, [](AsyncWebServerRequest *request){
    request->send(202, "application/json", "{\"status\":\"starting\"}");
  }, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    // Run OTA in a separate task to avoid blocking
    xTaskCreate([](void*){
      String tag, fwUrl, fsUrl, relPage, publishedAt, msg;
      bool ok = getGithubLatest(tag, fwUrl, fsUrl, relPage, publishedAt);
      if (ok && semverCompare(fwVersion, tag) < 0) {
        if (applyOtaFromUrl(fwUrl, msg)) {
          delay(250);
          ESP.restart();
        }
      }
      vTaskDelete(NULL);
    }, "ota_task", 8192, nullptr, 1, nullptr);
  });

  // OTA: update filesystem (LittleFS) from latest release asset when available
  server.on("/api/ota/updatefs", HTTP_POST, [](AsyncWebServerRequest *request){
    request->send(202, "application/json", "{\"status\":\"starting\"}");
  }, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    xTaskCreate([](void*){
      String tag, fwUrl, fsUrl, relPage, publishedAt, msg;
      bool ok = getGithubLatest(tag, fwUrl, fsUrl, relPage, publishedAt);
      if (ok && fsUrl.length()) {
        if (applyFsOtaFromUrl(fsUrl, msg)) {
          delay(250);
          ESP.restart();
        }
      }
      vTaskDelete(NULL);
    }, "ota_fs_task", 8192, nullptr, 1, nullptr);
  });

  // OTA: apply firmware first, then filesystem if available, then restart once
  server.on("/api/ota/update_all", HTTP_POST, [](AsyncWebServerRequest *request){
    request->send(202, "application/json", "{\"status\":\"starting\"}");
  }, NULL, [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total){
    xTaskCreate([](void*){
      String tag, fwUrl, fsUrl, relPage, publishedAt, msg;
      bool ok = getGithubLatest(tag, fwUrl, fsUrl, relPage, publishedAt);
      bool didSomething = false;
      // 1) Firmware update if newer
      if (ok && semverCompare(fwVersion, tag) < 0 && fwUrl.length()) {
        if (applyOtaFromUrl(fwUrl, msg)) {
          didSomething = true;
        }
      }
      // 2) Filesystem update if asset exists
      if (ok && fsUrl.length()) {
        String msg2;
        if (applyFsOtaFromUrl(fsUrl, msg2)) {
          didSomething = true;
        }
      }
      if (didSomething) {
        delay(300);
        ESP.restart();
      }
      vTaskDelete(NULL);
    }, "ota_all_task", 12288, nullptr, 1, nullptr);
  });

  // Full-resolution snapshot with graceful fallback and restoration
  server.on("/api/camera/snapshot_full", HTTP_GET, [](AsyncWebServerRequest *request){
    if (!cameraAvailable) { request->send(503, "application/json", "{\"error\":\"camera_unavailable\"}"); return; }
    int q = 12; // high quality (lower is better)
    if (request->hasParam("q")) {
      q = constrain(request->getParam("q")->value().toInt(), 10, 63);
    }
    // Optional explicit size override via query
    int target = -1;
    if (request->hasParam("size")) { target = request->getParam("size")->value().toInt(); }

    if (cameraMutex) xSemaphoreTake(cameraMutex, portMAX_DELAY);
    sensor_t *s = esp_camera_sensor_get();
    framesize_t prevFS = (framesize_t)appSettings.camFrameSize;
    int prevQ = appSettings.camQuality;
    if (s) {
      // Try UXGA -> SXGA -> XGA unless explicit size is provided
      framesize_t tries[3] = { FRAMESIZE_UXGA, FRAMESIZE_SXGA, FRAMESIZE_XGA };
      bool ok = false;
      camera_fb_t *fb = nullptr;
      if (target >= 0) {
        s->set_framesize(s, (framesize_t)target);
        s->set_quality(s, q);
        fb = esp_camera_fb_get();
        ok = (fb != nullptr);
      } else {
        for (int i = 0; i < 3 && !ok; i++) {
          s->set_framesize(s, tries[i]);
          s->set_quality(s, q);
          fb = esp_camera_fb_get();
          if (fb) ok = true;
        }
      }
      if (ok && fb) {
        // Build filename with resolution
        String fname = "snapshot_" + String(fb->width) + "x" + String(fb->height) + ".jpg";
        auto *resp = request->beginResponse(200, String("image/jpeg"), fb->buf, fb->len);
        resp->addHeader("Cache-Control", "no-store");
        resp->addHeader("Content-Disposition", String("inline; filename=") + fname);
        request->send(resp);
        esp_camera_fb_return(fb);
      } else {
        // Failure at all sizes
        request->send(500, "application/json", "{\"error\":\"fullres_failed\"}");
      }
      // Restore previous settings
      s->set_framesize(s, prevFS);
      s->set_quality(s, prevQ);
    } else {
      request->send(500, "application/json", "{\"error\":\"no_sensor\"}");
    }
    if (cameraMutex) xSemaphoreGive(cameraMutex);
  });
}

// Web task for sending periodic updates
void webTask(void *parameter) {
  const TickType_t xDelay = pdMS_TO_TICKS(1000); // 1 second updates
  
  for(;;) {
    if (WiFi.status() == WL_CONNECTED) {
      // Send data to all connected WebSocket clients
      String jsonData = generateJsonData();
      if (jsonData != lastJsonData && ws.count() > 0) {
        ws.textAll(jsonData);
        lastJsonData = jsonData;
        lastWebUpdate = millis();
      }
    }
    
    vTaskDelay(xDelay);
  }
}

// Sensor reading task - Ultra-high frequency with optimized I2C
void sensorTask(void *parameter) {
  const TickType_t xDelay = pdMS_TO_TICKS(SENSOR_UPDATE_INTERVAL_MS);
  
  for(;;) {
    unsigned long startTime = micros();
    
    if (sht30.read()) {
      EnvironmentData newData;
      newData.temperature = sht30.getTemperature();
      newData.humidity = sht30.getHumidity();
      newData.dewPoint = calculateDewPoint(newData.temperature, newData.humidity);
      newData.heatIndex = calculateHeatIndex(newData.temperature, newData.humidity);
      newData.vaporPressureDeficit = calculateVPD(newData.temperature, newData.humidity);
      newData.absoluteHumidity = calculateAbsoluteHumidity(newData.temperature, newData.humidity);
      newData.timestamp = millis();
      newData.valid = true;
      
      // Lock-free atomic update
      memcpy((void*)&currentData, &newData, sizeof(EnvironmentData));
      
      // Store in ring buffer for history
      readings[readingIndex] = newData;
      readingIndex = (readingIndex + 1) % 32;
      
      // Update statistics atomically
      updateStatisticsAtomic(newData.temperature, newData.humidity, newData.dewPoint);
      
      sensorReadCount++;
      lastSensorRead = millis();
      
      // Send to queue for display task
      if (sensorDataQueue != NULL) {
        xQueueSend(sensorDataQueue, &newData, 0);
      }
    }
    
    vTaskDelay(xDelay);
  }
}

// Display task - Moderate frequency for human-readable output
void displayTask(void *parameter) {
  EnvironmentData data;
  const TickType_t xDelay = pdMS_TO_TICKS(DISPLAY_UPDATE_INTERVAL_MS);
  
  for(;;) {
    if (xQueueReceive(sensorDataQueue, &data, xDelay) == pdTRUE) {
      if (data.valid) {
        printUltraFastReading(data);
        displayUpdateCount++;
        lastDisplayUpdate = millis();
      }
    }
    
    vTaskDelay(xDelay);
  }
}

// LED status task - Fast visual feedback
void ledTask(void *parameter) {
  const TickType_t xDelay = pdMS_TO_TICKS(100); // 10Hz LED updates
  
  for(;;) {
    if (currentData.valid) {
      updateLEDStatusFast(currentData.temperature, currentData.humidity);
    }
    
    vTaskDelay(xDelay);
  }
}

void setup() {
  // Initialize serial with maximum baud rate for data throughput
  Serial.begin(SERIAL_BAUD_RATE);
  Serial.println("\nESP32 XIAO S3 Reptile Monitor with Web Server");
  Serial.println("===================================================================");

  // Load persisted settings early
  loadAppSettings();
  
  // Initialize built-in LEDs
  pinMode(LED_BUILTIN_RED, OUTPUT);
  pinMode(LED_BUILTIN_BLUE, OUTPUT);
  digitalWrite(LED_BUILTIN_RED, LOW);
  digitalWrite(LED_BUILTIN_BLUE, LOW);
  
  // Initialize I2C with maximum speed for ultra-fast sensor readings
  // XIAO ESP32S3: SDA=5, SCL=6
  Wire.begin(5, 6);
  Wire.setClock(I2C_CLOCK_SPEED);
  
  // Initialize SHT30 sensor
  if (sht30.begin()) {
  Serial.println("SHT30 sensor initialized successfully");
  } else {
  Serial.println("SHT30 sensor initialization failed!");
    while(1) {
      digitalWrite(LED_BUILTIN_RED, HIGH);
      delay(500);
      digitalWrite(LED_BUILTIN_RED, LOW);
      delay(500);
    }
  }
  
  // Setup WiFi
  // Improve WiFi stability for AP and STA
  WiFi.persistent(false);
  WiFi.setSleep(false);
  setupWiFi();

  // Initialize camera (best-effort)
  initCamera();
  camStatFrames = 0; camStatBytes = 0; camStatStartMs = millis();
  // Create camera mutex
  cameraMutex = xSemaphoreCreateMutex();
  
  // Setup web server
  setupWebServer();
  
  // Create FreeRTOS synchronization objects
  sensorDataQueue = xQueueCreate(16, sizeof(EnvironmentData));
  dataMutex = xSemaphoreCreateMutex();
  
  if (sensorDataQueue == NULL || dataMutex == NULL) {
  Serial.println("Failed to create FreeRTOS objects!");
    while(1);
  }
  
  // Create high-priority tasks with optimized stack sizes
  xTaskCreatePinnedToCore(
    sensorTask,           // Task function
    "SensorTask",         // Task name
    4096,                 // Stack size
    NULL,                 // Parameters
    3,                    // Priority (high)
    &sensorTaskHandle,    // Task handle
    1                     // Core 1
  );
  
  xTaskCreatePinnedToCore(
    displayTask,          // Task function
    "DisplayTask",        // Task name
    4096,                 // Stack size
    NULL,                 // Parameters
    2,                    // Priority (medium)
    &displayTaskHandle,   // Task handle
    0                     // Core 0
  );
  
  xTaskCreatePinnedToCore(
    ledTask,              // Task function
    "LEDTask",            // Task name
    2048,                 // Stack size
    NULL,                 // Parameters
    1,                    // Priority (low)
    &ledTaskHandle,       // Task handle
    0                     // Core 0
  );
  
  xTaskCreatePinnedToCore(
    webTask,              // Task function
    "WebTask",            // Task name
    8192,                 // Stack size (larger for JSON)
    NULL,                 // Parameters
    2,                    // Priority (medium)
    &webTaskHandle,       // Task handle
    0                     // Core 0
  );
  
  Serial.printf("CPU Frequency: %d MHz\n", getCpuFrequencyMhz());
  Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
  Serial.printf("Target sensor rate: %.1f Hz\n", 1000.0f / SENSOR_UPDATE_INTERVAL_MS);
  Serial.printf("Target display rate: %.1f Hz\n", 1000.0f / DISPLAY_UPDATE_INTERVAL_MS);
  Serial.println("===================================================================");
  Serial.println("Web interface ready. Open your browser and navigate to the IP address shown above.");
  Serial.println("Access from any device on your network.");
  Serial.println("Monitoring started - real-time reptile environment data");
  Serial.println("===================================================================\n");
}

void loop() {
  // Handle serial commands for system control
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    command.toLowerCase();
    
    if (command == "stats") {
  Serial.println("\nSYSTEM PERFORMANCE STATISTICS");
      Serial.println("===================================================================");
      Serial.printf("Sensor readings: %lu (%.1fHz)\n", sensorReadCount,
                    sensorReadCount * 1000.0f / millis());
      Serial.printf("Display updates: %lu (%.1fHz)\n", displayUpdateCount,
                    displayUpdateCount * 1000.0f / millis());
      Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
      Serial.printf("Min free heap: %d bytes\n", ESP.getMinFreeHeap());
      Serial.printf("CPU frequency: %d MHz\n", getCpuFrequencyMhz());
      Serial.printf("Uptime: %.1f minutes\n", millis() / 60000.0f);
      Serial.printf("WiFi status: %s\n", WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected");
      Serial.printf("WebSocket clients: %d\n", ws.count());
      Serial.println("===================================================================\n");
    }
    else if (command == "reset") {
      ESP.restart();
    }
    else if (command == "wifi") {
      if (WiFi.status() == WL_CONNECTED) {
  Serial.printf("WiFi: %s\n", selectedSSID.c_str());
  Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
      } else {
  Serial.println("WiFi not connected");
      }
    }
    else if (command == "help") {
  Serial.println("\nAVAILABLE COMMANDS:");
      Serial.println("stats  - Show performance statistics");
      Serial.println("wifi   - Show WiFi information");
      Serial.println("scan   - Scan for WiFi networks");
      Serial.println("reset  - Restart the system");
      Serial.println("help   - Show this help\n");
    }
    else if (command == "scan") {
  Serial.println("Restarting to scan networks...");
      delay(1000);
      ESP.restart();
    }
  }
  
  // Finalize non-blocking WiFi connect
  if (wifiConnectPending) {
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECTED) {
      // Save credentials
      preferences.begin("wifi", false);
      preferences.putString("ssid", pendingSSID);
      preferences.putString("pass", pendingPass);
      preferences.end();
      selectedSSID = pendingSSID;
      selectedPassword = pendingPass;
      wifiConnectPending = false;
      // Notify portal clients BEFORE stopping AP so the message can be received
      {
        DynamicJsonDocument doc(256);
        doc["event"] = "wifi_connected";
        doc["ip"] = WiFi.localIP().toString();
        String msg; serializeJson(doc, msg);
        ws.textAll(msg);
      }
      // Small delay to allow message flush
      delay(250);
      // Stop AP/captive DNS now that we're connected
      if (useAccessPoint) {
        dnsServer.stop();
        captivePortalActive = false;
        WiFi.softAPdisconnect(true);
        useAccessPoint = false;
      }
      // Start mDNS for LAN discovery
      mdnsActive = MDNS.begin(mdnsHostname.c_str());
      if (!mdnsActive) {
        Serial.println("mDNS failed to start after connect");
      } else {
        MDNS.addService("http", "tcp", 80);
        Serial.printf("mDNS active: http://%s.local\n", mdnsHostname.c_str());
      }
      Serial.println("WiFi connected (non-blocking flow)");
  } else if (millis() - wifiConnectStart > 25000) { // timeout
      wifiConnectPending = false;
      // Revert to AP
      uint64_t chipid = ESP.getEfuseMac();
      char idbuf[7];
      sprintf(idbuf, "%06X", (uint32_t)(chipid & 0xFFFFFF));
  ap_ssid_dyn = String("ReptiMon-") + idbuf;
      WiFi.softAP(ap_ssid_dyn.c_str(), ap_password);
      useAccessPoint = true;
      captivePortalActive = true;
      dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
      DynamicJsonDocument doc(256);
      doc["event"] = "wifi_failed";
      doc["reason"] = "timeout";
      doc["ap_ip"] = WiFi.softAPIP().toString();
      String msg; serializeJson(doc, msg);
      ws.textAll(msg);
  Serial.println("WiFi connect timeout; reverted to AP");
    }
  }

  // Process captive portal DNS if active
  if (captivePortalActive) {
    dnsServer.processNextRequest();
  }

  // System health monitoring
  static unsigned long lastHealthCheck = 0;
  if (millis() - lastHealthCheck > 30000) { // Every 30 seconds
    lastHealthCheck = millis();
    
    // Check if tasks are running
    if (sensorTaskHandle == NULL || displayTaskHandle == NULL || ledTaskHandle == NULL || webTaskHandle == NULL) {
  Serial.println("Task failure detected!");
    }
    
    // Memory check
    if (ESP.getFreeHeap() < 50000) { // Less than 50KB free
  Serial.printf("Low memory: %d bytes free\n", ESP.getFreeHeap());
    }
    
    // WiFi check
    if (WiFi.status() != WL_CONNECTED) {
  Serial.println("WiFi disconnected, attempting reconnection...");
      WiFi.reconnect();
    }
  }
  
  // Clean WebSocket connections
  ws.cleanupClients();
  
  // Minimal delay to prevent watchdog issues
  delay(100);
}