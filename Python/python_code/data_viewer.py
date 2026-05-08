### Simple live viewer for PPG data streamed over Bluetooth from the NanoESP32_PPG firmware.

import asyncio
import contextlib
import re
import threading
import time
from collections import deque

import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt

from bleak import BleakScanner, BleakClient
from bleak.exc import BleakError

DEVICE_NAME = "NanoESP32_PPG"
TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

lines_this_second = 0
total_lines = 0
start_time = None

_pending = deque()
_pending_lock = threading.Lock()
_connected_event = threading.Event()
_stop_event = threading.Event()

_rate_instant = 0.0
_rate_avg = 0.0
_last_rx_time = 0.0


def on_notify(sender, data: bytearray):
    global lines_this_second, total_lines, _last_rx_time
    txt = data.decode("utf-8", errors="ignore").strip()
    if not txt:
        return
    # Firmware sends 4 comma-separated samples per notification: "v1,v2,v3,v4\n"
    for raw_line in txt.splitlines():
        values = [int(x) for x in re.findall(r"\d+", raw_line)]
        if values:
            with _pending_lock:
                _pending.extend(values)
            lines_this_second += len(values)
            total_lines += len(values)
            _last_rx_time = time.time()


async def scan_for_device(timeout=10):
    print(f"Scanning for {DEVICE_NAME}...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for dev, adv in devices.values():
        name = dev.name or adv.local_name
        if name == DEVICE_NAME:
            print(f"Found: {name} ({dev.address}) RSSI={adv.rssi}")
            return dev
    return None


async def rate_monitor(client):
    global lines_this_second, start_time, total_lines, _rate_instant, _rate_avg
    start_time = time.time()
    while client.is_connected and not _stop_event.is_set():
        await asyncio.sleep(5.0)
        elapsed = time.time() - start_time
        _rate_instant = lines_this_second / 5.0
        _rate_avg = (total_lines / elapsed) if elapsed > 0 else 0.0
        lines_this_second = 0


async def connect_and_stream():
    global lines_this_second, total_lines
    while not _stop_event.is_set():
        dev = await scan_for_device()
        if not dev:
            print("Device not found. Retrying in 2s...")
            await asyncio.sleep(2)
            continue
        try:
            print(f"Connecting to {dev.name} ({dev.address})...")
            async with BleakClient(dev, timeout=20.0) as client:
                if not client.is_connected:
                    print("Connect failed.")
                    await asyncio.sleep(2)
                    continue

                lines_this_second = 0
                total_lines = 0

                print("Connected. Subscribing...")
                await client.start_notify(TX_CHAR_UUID, on_notify)
                print("Streaming... Ctrl+C to stop.")

                _connected_event.set()

                rate_task = asyncio.create_task(rate_monitor(client))
                try:
                    while client.is_connected and not _stop_event.is_set():
                        await asyncio.sleep(0.5)
                finally:
                    rate_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await rate_task
                    await client.stop_notify(TX_CHAR_UUID)

                print("Disconnected. Reconnecting...")

        except BleakError as e:
            print(f"BleakError: {repr(e)}")
            await asyncio.sleep(2)
        except Exception as e:
            print(f"Exception: {type(e).__name__}: {repr(e)}")
            await asyncio.sleep(2)


def _run_ble_thread() -> threading.Thread:
    def runner():
        try:
            asyncio.run(connect_and_stream())
        except Exception as e:
            print(f"BLE thread crashed: {type(e).__name__}: {e!r}")
            _stop_event.set()
            _connected_event.set()

    t = threading.Thread(target=runner, name="ble-thread", daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    try:
        ble_thread = _run_ble_thread()

        print("Waiting for Bluetooth connection...")
        _connected_event.wait()

        if _stop_event.is_set():
            print("BLE failed to connect. Exiting.")
            raise SystemExit(1)

        print("Connected! Opening plot...")

        POINTS = 600
        y_data = [0.0] * POINTS       # pre-filled, scrolls as new samples arrive
        x_data = list(range(POINTS))

        plt.ion()
        fig, ax = plt.subplots()
        try:
            fig.canvas.manager.set_window_title("PPG Live Viewer (BLE)")
        except Exception:
            pass

        ax.set_title("Live PPG — BLE")
        ax.set_xlabel("Samples")
        ax.set_ylabel("PPG value")
        ax.set_xlim(0, POINTS - 1)
        ax.set_ylim(-200, 4200)
        ax.grid(True, alpha=0.25)

        (plot_line,) = ax.plot(x_data, y_data, lw=1.0, color="steelblue")
        info = ax.text(0.01, 0.99, "", transform=ax.transAxes,
                       va="top", ha="left", fontsize=8,
                       bbox=dict(boxstyle="round,pad=0.2", fc="white", alpha=0.7))

        fig.tight_layout()
        fig.canvas.draw()
        plt.show(block=False)

        while not _stop_event.is_set() and plt.fignum_exists(fig.number):
            with _pending_lock:
                new_vals = list(_pending)
                _pending.clear()

            if new_vals:
                y_data.extend(float(v) for v in new_vals)
                # keep only the last POINTS samples
                if len(y_data) > POINTS:
                    del y_data[:len(y_data) - POINTS]
                plot_line.set_ydata(y_data)

            age = (time.time() - _last_rx_time) if _last_rx_time else float("inf")
            info.set_text(
                f"total={total_lines} | window={POINTS}\n"
                f"rate≈{_rate_instant:.2f} Hz (5s)  avg≈{_rate_avg:.2f} Hz  last_rx={age:.2f}s"
            )

            fig.canvas.draw_idle()
            fig.canvas.flush_events()
            time.sleep(0.03)

        plt.close(fig)

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        _stop_event.set()