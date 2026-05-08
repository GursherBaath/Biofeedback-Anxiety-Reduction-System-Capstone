import asyncio
import threading
import time
import re
from datetime import datetime, timedelta
from bleak import BleakScanner, BleakClient
import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt

DEVICE_NAME = "NanoESP32_PPG"
TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

_pending = []
_pending_lock = threading.Lock()
_stop_event = threading.Event()
_connected_event = threading.Event()

def on_notify(sender, data: bytearray):
    txt = data.decode("utf-8", errors="ignore").strip()
    if not txt:
        return
    for raw_line in txt.splitlines():
        values = [int(x) for x in re.findall(r"\d+", raw_line)]
        if values:
            with _pending_lock:
                _pending.extend(values)

async def scan_for_device(timeout=10):
    print(f"Scanning for {DEVICE_NAME}...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for dev, adv in devices.values():
        name = dev.name or adv.local_name
        if name == DEVICE_NAME:
            print(f"Found: {name} ({dev.address}) RSSI={adv.rssi}")
            return dev
    return None

def connect_and_stream(stop_event, connected_event):
    async def _run():
        dev = await scan_for_device()
        if not dev:
            print("Device not found.")
            return False
        try:
            print(f"Connecting to {dev.name} ({dev.address})...")
            async with BleakClient(dev, timeout=20.0) as client:
                if not client.is_connected:
                    print("Connect failed.")
                    return False
                print("Connected. Subscribing...")
                await client.start_notify(TX_CHAR_UUID, on_notify)
                print("Streaming... (Close window or Ctrl+C to stop)")
                connected_event.set()
                while client.is_connected and not stop_event.is_set():
                    await asyncio.sleep(0.5)
                await client.stop_notify(TX_CHAR_UUID)
                print("Disconnected.")
                return True
        except Exception as e:
            print(f"Exception: {type(e).__name__}: {repr(e)}")
            return False
    # Use asyncio.get_event_loop() if already running, else asyncio.run
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        return asyncio.ensure_future(_run())
    else:
        return asyncio.run(_run())

def run_ble_thread():
    t = threading.Thread(target=connect_and_stream, args=(_stop_event, _connected_event), daemon=True)
    t.start()
    return t

def main():
    print("\n=== Battery Life Test ===\n")
    print("This will stream PPG data and measure battery life.\n")
    _pending.clear()
    _stop_event.clear()
    _connected_event.clear()
    start_time = None
    end_time = None
    fig, ax = plt.subplots(figsize=(10, 5))
    plt.title("Live PPG Data (Battery Life Test)")
    plt.xlabel("Sample")
    plt.ylabel("PPG Value")
    line, = ax.plot([], [], lw=1)
    plt.tight_layout()
    plt.ion()
    plt.show(block=False)
    data = []
    # Add a text annotation for the stopwatch
    stopwatch_text = ax.text(0.98, 0.02, '', transform=ax.transAxes, fontsize=14, color='blue', ha='right', va='bottom', bbox=dict(facecolor='white', alpha=0.7, edgecolor='none'))
    t_ble = run_ble_thread()
    print("Waiting for device to connect...")
    if not _connected_event.wait(timeout=30):
        print("Failed to connect to device.")
        return
    print("Connected! Starting stopwatch.")
    start_time = time.time()
    last_update = time.time()
    try:
        while t_ble.is_alive() and not _stop_event.is_set():
            with _pending_lock:
                if _pending:
                    data.extend(_pending)
                    _pending.clear()
            if data:
                line.set_data(range(len(data)), data)
                ax.relim()
                ax.autoscale_view()
            # Show stopwatch on the graph
            elapsed = time.time() - start_time
            h, rem = divmod(int(elapsed), 3600)
            m, s = divmod(rem, 60)
            stopwatch_text.set_text(f"Elapsed: {h:02}:{m:02}:{s:02}")
            plt.draw()
            plt.pause(0.05)
    except KeyboardInterrupt:
        print("\nStopped by user.")
        _stop_event.set()
    end_time = time.time()
    total_seconds = int(end_time - start_time) if start_time else 0
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    print("\n\n=== Battery Life Test Complete ===")
    print(f"Battery life: {h}h {m}m {s}s")
    # Output result to console only
    result_str = f"Battery life: {h}h {m}m {s}s"
    date_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{date_str},{h:02}:{m:02}:{s:02}")
    # Append result to battery_life.txt
    result_path = "battery_life.txt"
    header_needed = False
    try:
        with open(result_path, "r") as f:
            if not f.readline().startswith("date"):
                header_needed = True
    except FileNotFoundError:
        header_needed = True
    with open(result_path, "a") as f:
        if header_needed:
            f.write("date,result\n")
        f.write(f"{date_str},{h:02}:{m:02}:{s:02}\n")
    print(f"Result appended to {result_path}")

if __name__ == "__main__":
    main()
