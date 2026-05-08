# HRV Analysis API (LAN Demo)

FastAPI-based REST API for calculating HRV RMSSD from PPG data with signal quality checks. This version is configured for local network demos (phones on the same Wi-Fi).

## Features

- Calculate HRV RMSSD (Root Mean Square of Successive Differences) from PPG data
- Signal quality assessment using 3-second segment analysis
- Configurable tolerance for bad signal segments
- CORS enabled for web/mobile clients on the same network
- Auto-generated API docs via FastAPI

## Setup

### Prerequisites

- Python 3.8+
- pip

### Install

```bash
pip install -r requirements.txt
```

## Run (LAN Access)

```bash
python main.py
```

The API binds to `0.0.0.0:8000`, which makes it reachable from other devices on the same network.

## Build a Windows .exe

This creates a single-file executable you can run on the demo laptop.

```powershell
./build.ps1
```

The output is:

```
dist\hrv-api.exe
```

Run it:

```powershell
./dist/hrv-api.exe
```

If Windows Defender prompts for network access, allow it for Private networks.

### Find Your LAN IP

On Windows:
```bash
ipconfig
```
Use the IPv4 address (example: `192.168.1.42`).

### Test From a Phone

- Open `http://<your-lan-ip>:8000/docs`
- Health check: `http://<your-lan-ip>:8000/health`

### Windows Firewall

Allow inbound TCP on port 8000:

- Windows Defender Firewall > Advanced Settings > Inbound Rules > New Rule
- Port > TCP > 8000 > Allow

## CORS (Web/React Clients)

CORS is enabled by default for demo use. You can restrict origins with:

```bash
set HRV_ALLOWED_ORIGINS=http://192.168.1.42:5173,http://192.168.1.42:3000
```

Use `*` to allow all origins (default).

## API Endpoints

### `GET /`
Returns basic API info and endpoints.

### `GET /health`
Health check.

### `POST /analyze`
Analyze PPG data and calculate RMSSD with signal quality checks.

#### Request

```json
{
  "ppg_data": [438, 445, 452, 460, 468, ...],
  "sampling_rate": 100,
  "max_bad_segments": 0
}
```

#### Success Response (200)

```json
{
  "success": true,
  "rmssd": 42.56,
  "bad_segments": 0
}
```

#### Error Response (422)

```json
{
  "detail": {
    "success": false,
    "error": "Poor signal quality: 3 bad segments detected (max allowed: 2)",
    "bad_segments": 3
  }
}
```

## React/Phone Demo Notes

- Phone and laptop must be on the same Wi-Fi.
- Use the laptop LAN IP for API requests (not `localhost`).
- If the React dev server is running on the laptop, also bind it to `0.0.0.0` and open it via LAN IP on the phone.

## Old Files

Archived versions are in the `old` folder.
