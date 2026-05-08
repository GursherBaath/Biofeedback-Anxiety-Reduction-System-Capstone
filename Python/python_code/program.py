def clean_peaks(ppg_window, peak_indices, rising_window=5, min_distance=20):
    """
    Clean peaks by first removing those on rising edges, then removing close peaks (keep largest).
    Args:
        ppg_window: The PPG signal (numpy array or list)
        peak_indices: List/array of candidate peak indices (relative to ppg_window)
        rising_window: Number of samples to check after the peak for a rising edge
        min_distance: Minimum number of samples between peaks
    Returns:
        Cleaned list of peak indices
    """
    # Initial cleaning: remove peaks on rising edges
    cleaned = initial_cleaning(ppg_window, peak_indices, rising_window)

    # Remove close peaks, keeping the largest in each group
    i = 0
    while i < len(cleaned) - 1:
        if cleaned[i+1] - cleaned[i] < min_distance:
            if ppg_window[cleaned[i]] >= ppg_window[cleaned[i+1]]:
                cleaned.pop(i+1)  # remove next peak
            else:
                cleaned.pop(i)    # remove current peak
        else:
            i += 1
    return cleaned

def initial_cleaning(ppg_window, peak_indices, rising_window=5):
    """
    Remove peaks where a long string of increasing samples follows the peak.
    Args:
        ppg_window: The PPG signal (numpy array or list)
        peak_indices: List/array of candidate peak indices (relative to ppg_window)
        rising_window: Number of samples to check after the peak for a rising edge
    Returns:
        Cleaned list of peak indices
    """
    cleaned = []
    for idx in peak_indices:
        # Check if the next rising_window samples are strictly increasing
        end_idx = min(idx + rising_window + 1, len(ppg_window))
        after = ppg_window[idx:end_idx]
        if len(after) > 1 and all(after[i] < after[i+1] for i in range(len(after)-1)):
            continue  # skip this peak, it's on a rising edge
        cleaned.append(idx)
    return cleaned
import os
import sys
import asyncio
import threading
import queue as queue_module
from bleak import BleakScanner, BleakClient
import time
from datetime import datetime
from collections import deque
import numpy as np
import neurokit2 as nk
import warnings

# Suppress all warnings from neurokit2 and pandas
warnings.filterwarnings('ignore')

# BLE settings
BLE_DEVICE_NAME = "NanoESP32_PPG"
TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"


class TeeStdout:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)

    def flush(self):
        for stream in self.streams:
            stream.flush()


def scan_ble_devices(timeout=10):
    """Scan for BLE devices matching the PPG sensor"""
    async def _scan():
        print(f"\nScanning for BLE device '{BLE_DEVICE_NAME}'...")
        devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
        found = []
        for dev, adv in devices.values():
            name = dev.name or adv.local_name or ""
            if name == BLE_DEVICE_NAME:
                found.append(dev)
                print(f"  Found: {name} ({dev.address}) RSSI={adv.rssi}")
        if not found:
            print("No PPG devices found!")
        return found
    return asyncio.run(_scan())


def get_user_input():
    """Get recording parameters from user"""
    print("\n" + "="*60)
    print("HRV MONITORING SYSTEM - Meditation Feedback")
    print("="*60)
    
    # Scan for BLE devices
    devices = scan_ble_devices()
    if not devices:
        return None, None
    
    if len(devices) == 1:
        device = devices[0]
        print(f"\nAuto-selected device: {device.name} ({device.address})")
    else:
        print("\nMultiple devices found:")
        for i, dev in enumerate(devices):
            print(f"  {i+1}. {dev.name} ({dev.address})")
        choice = input(f"\nSelect device number (1-{len(devices)}): ").strip()
        try:
            idx = int(choice) - 1
            if idx < 0 or idx >= len(devices):
                print("Invalid selection!")
                return None, None
            device = devices[idx]
        except ValueError:
            print("Invalid input!")
            return None, None
    
    # Get duration
    duration_input = input("\nEnter recording duration in seconds (e.g., 180 for 3 minutes): ").strip()
    try:
        duration = int(duration_input)
        if duration < 30:
            print("Duration must be at least 30 seconds for HRV calculation!")
            return None, None
    except ValueError:
        print("Invalid duration!")
        return None, None
    
    return device.address, duration


def parse_ppg_signal(line):
    """Extract PPG signal values from comma-separated batch (e.g., '438,442,445,440')"""
    try:
        values = [int(v.strip()) for v in line.split(',') if v.strip()]
        return values if values else None
    except ValueError:
        return None


def calculate_hrv_rmssd(ppg_window, sampling_rate=100):
    """
    Calculate HRV using RMSSD from PPG signal
    
    Args:
        ppg_window: Array of PPG signal values
        sampling_rate: Sampling rate in Hz (default 100)
    
    Returns:
        RMSSD value in ms, or None if calculation fails
    """
    if len(ppg_window) < sampling_rate * 10:
        return None, []

    global appended_samples

    step_samples = sampling_rate * 10
    if appended_samples == 0:
        new_samples = ppg_window
    else:
        new_samples = ppg_window[-step_samples:]

    ppg_window_data_combined.extend(new_samples)
    appended_samples += len(new_samples)

    try:
        signals, info = nk.ppg_process(ppg_window, sampling_rate=sampling_rate)

        # Detect raw peaks
        if 'PPG_Peaks' in signals:
            peaks_indices = np.where(signals['PPG_Peaks'] == 1)[0]
        else:
            peaks_indices = np.array([])

        # Clean the peaks
        cleaned_peaks = clean_peaks(ppg_window, list(peaks_indices))

        # Offset peaks by absolute index of window start
        window_start_index = appended_samples - len(ppg_window)
        cleaned_peaks_global = [i + window_start_index for i in cleaned_peaks]

        # Create a new PPG_Peaks array with only cleaned peaks (optional, for HRV calc)
        ppg_peaks_clean = np.zeros(len(ppg_window), dtype=int)
        for idx in cleaned_peaks:
            if 0 <= idx < len(ppg_peaks_clean):
                ppg_peaks_clean[idx] = 1
        signals['PPG_Peaks'] = ppg_peaks_clean

        # Return both RMSSD and the global cleaned peak indices for overlap filtering
        hrv_metrics = nk.ppg_intervalrelated(signals, sampling_rate=sampling_rate)
        rmssd = hrv_metrics['HRV_RMSSD'].values[0]
        return rmssd, cleaned_peaks_global
    except Exception as e:
        print(f"\n[WARNING] HRV calculation failed: {e}")
        return None, []


def check_hrv_status(current_rmssd, previous_rmssd):
    """
    Determine HRV status based on change from previous measurement
    
    Returns:
        0: Better (improvement) - GREEN
        1: Drops less than 5ms - YELLOW
        2: Drops 5ms or more - RED
    
    Args:
        current_rmssd: Current window RMSSD value
        previous_rmssd: Previous window RMSSD value
    
    Returns:
        Integer: 0, 1, or 2 representing status
    """
    if previous_rmssd is None or current_rmssd is None:
        return 1  # Default to yellow if no previous data
    
    # Calculate change (current - previous)
    change = current_rmssd - previous_rmssd
    
    if change >= 0:
        # Improved or stayed the same
        return 0  # GREEN
    elif change > -5:
        # Dropped but less than 5ms
        return 1  # YELLOW
    else:
        # Dropped 5ms or more
        return 2  # RED


def display_feedback(status, current_rmssd, previous_rmssd, window_number):
    """
    Display visual feedback to user with color-coded status
    
    Args:
        status: 0 (green), 1 (yellow), or 2 (red)
        current_rmssd: Current RMSSD value
        previous_rmssd: Previous RMSSD value
        window_number: Current window number
    """
    # Define status information
    status_info = {
        0: {"symbol": "✓", "color": "GREEN", "message": "EXCELLENT - HRV IMPROVING"},
        1: {"symbol": "~", "color": "YELLOW", "message": "GOOD - SLIGHT DECREASE"},
        2: {"symbol": "✗", "color": "RED", "message": "REFOCUS - SIGNIFICANT DROP"}
    }
    
    info = status_info.get(status, status_info[1])
    
    # Calculate change
    if previous_rmssd is not None:
        change = current_rmssd - previous_rmssd
        change_str = f"{change:+.2f} ms"
    else:
        change_str = "N/A (first reading)"
    
    print(f"\n{'='*60}")
    print(f"Window #{window_number}")
    print(f"RMSSD: {current_rmssd:.2f} ms | Change: {change_str}")
    print(f"Status: [{info['symbol']}] {info['color']} - {info['message']}")
    print(f"{'='*60}")


def is_segment_bad(segment, sampling_rate):
    """
    Quick SQI checks to detect bad 3s segments.
    Returns True if the segment is likely corrupted.
    """
    if len(segment) == 0:
        print("[DEBUG] Segment is empty")
        return True

    seg = np.asarray(segment, dtype=float)

    # Flatline / low variance
    if np.std(seg) < 1.0:
        print("[DEBUG] Segment failed flatline/low variance check")
        return True

    # Clipping / saturation (too many identical values)
    unique_ratio = len(np.unique(seg)) / len(seg)
    if unique_ratio < 0.02:
        print("[DEBUG] Segment failed clipping/saturation check")
        return True

    # Extreme jump check
    if np.max(np.abs(np.diff(seg))) > 2000:  # tweak if needed
        print("[DEBUG] Segment failed extreme jump check")
        return True

    # Peak plausibility (very rough)
    try:
        peaks, _ = nk.ppg_peaks(seg, sampling_rate=sampling_rate)
        if "PPG_Peaks" in peaks:
            peak_count = int(np.sum(peaks["PPG_Peaks"]))
        else:
            peak_count = 0

        # For 3s segment, expect roughly 2–6 peaks at 40–120 bpm
        if peak_count < 2 or peak_count > 6:
            print("[DEBUG] Segment failed peak plausibility check")
            return True
    except Exception:
        return True

    return False


def is_window_bad(ppg_window, sampling_rate, segment_sec=3, max_bad_segments=0):
    """
    Split window into 3s segments and flag if too many are bad.
    Default strict policy: if any segment is bad, window is bad.
    """
    seg_len = int(segment_sec * sampling_rate)
    if seg_len <= 0:
        return True

    bad_segments = 0
    total_segments = len(ppg_window) // seg_len

    for i in range(total_segments):
        start = i * seg_len
        end = start + seg_len
        segment = ppg_window[start:end]
        if is_segment_bad(segment, sampling_rate):
            bad_segments += 1
            print(f"[DEBUG] Bad segment detected in window (segment #{i+1})")
            if bad_segments > max_bad_segments:
                return True

    return False


def _ble_stream_thread(device_address, data_queue, stop_event, connected_event):
    """Background thread: connect to BLE device and stream PPG data into a queue"""
    async def _run():
        try:
            async with BleakClient(device_address, timeout=20.0) as client:
                if not client.is_connected:
                    print("\nBLE connection failed!")
                    return

                connected_event.set()

                def on_notify(sender, data: bytearray):
                    txt = data.decode("utf-8", errors="ignore").strip()
                    for line in txt.split('\n'):
                        line = line.strip()
                        if line:
                            values = parse_ppg_signal(line)
                            if values:
                                for v in values:
                                    data_queue.put(v)

                await client.start_notify(TX_CHAR_UUID, on_notify)

                while not stop_event.is_set() and client.is_connected:
                    await asyncio.sleep(0.1)

                await client.stop_notify(TX_CHAR_UUID)
        except Exception as e:
            print(f"\nBLE error: {e}")

    asyncio.run(_run())


def collect_and_analyze_hrv(device_address, duration):
    """
    Main function to collect PPG data via BLE and perform real-time HRV analysis
    
    Uses rolling 30-second windows, updating every 10 seconds
    """
    SAMPLING_RATE = 100  # Approximate sampling rate (Hz)
    WINDOW_SIZE_SEC = 30
    UPDATE_INTERVAL_SEC = 10
    
    window_size_samples = WINDOW_SIZE_SEC * SAMPLING_RATE
    
    # Set up BLE communication via queue
    data_queue = queue_module.Queue()
    stop_event = threading.Event()
    connected_event = threading.Event()

    # Ensure global data containers are defined and initialized
    global all_ppg_data, ppg_window_data_combined, ppg_peaks_data_combined, appended_samples
    all_ppg_data = []  # Store all data
    ppg_window_data_combined = []  # Store windowed data for analysis
    ppg_peaks_data_combined = []  # Store peaks data for analysis
    appended_samples = 0

    # Rolling buffer for the current window
    ppg_buffer = deque(maxlen=window_size_samples)

    ble_thread = threading.Thread(
        target=_ble_stream_thread,
        args=(device_address, data_queue, stop_event, connected_event),
        daemon=True
    )

    try:
        print(f"\n{'='*60}")
        print(f"Connecting to BLE device {device_address}...")
        ble_thread.start()

        # Wait for BLE connection
        if not connected_event.wait(timeout=30):
            print("Failed to connect to BLE device within 30 seconds.")
            stop_event.set()
            return

        print(f"Connected to {device_address} via BLE")
        print(f"Recording for {duration} seconds...")
        print(f"HRV calculated every 10 seconds using 30-second windows")
        print(f"{'='*60}")
        print("\nStatus Colors:")
        print("  GREEN (✓)  - HRV improving")
        print("  YELLOW (~) - Minor decrease (< 5ms)")
        print("  RED (✗)    - Significant decrease (≥ 5ms)")
        print(f"{'='*60}")
        print("\nCollecting initial data (30 seconds)...\n")

        last_peak_sample = -1  # Track last sample index for which a peak was added
        last_calculation_time = 0.0
        previous_rmssd = None
        window_count = 0
        sample_count = 0

        # Track status counts for summary
        status_counts = {0: 0, 1: 0, 2: 0}

        while True:
            # Read PPG data from BLE queue
            try:
                while True:
                    ppg_value = data_queue.get_nowait()
                    ppg_buffer.append(ppg_value)
                    all_ppg_data.append(ppg_value)
                    sample_count += 1
                    # Print progress
                    if sample_count % 100 == 0:
                        data_time = sample_count / SAMPLING_RATE
                        print(f"Samples collected: {sample_count} | Time: {data_time:.1f}s", end='\r')
            except queue_module.Empty:
                pass

            # Small sleep to avoid busy-waiting
            time.sleep(0.01)

            # Use data-derived time so windows align with samples
            data_time = sample_count / SAMPLING_RATE

            # Perform HRV calculation every 10 seconds (after initial 30 seconds)
            if (data_time >= WINDOW_SIZE_SEC and 
                data_time - last_calculation_time >= UPDATE_INTERVAL_SEC and
                len(ppg_buffer) >= window_size_samples * 0.8):  # Allow 20% tolerance

                window_count += 1
                last_calculation_time = data_time

                # Calculate HRV for current window
                ppg_window = np.array(ppg_buffer)

                # Segment-based quality check (10 x 3s segments)
                if is_window_bad(ppg_window, SAMPLING_RATE, segment_sec=3, max_bad_segments=15):
                    print(f"\n[Window #{window_count}] Bad data detected (segment SQI). Skipping HRV.")
                    continue

                current_rmssd, peaks_indices = calculate_hrv_rmssd(ppg_window, SAMPLING_RATE)
                # Only add peaks that are after the last_peak_sample
                new_peaks = [i for i in peaks_indices if i > last_peak_sample]
                if new_peaks:
                    last_peak_sample = max(new_peaks)
                ppg_peaks_data_combined.extend(new_peaks)

                if current_rmssd is not None:
                    # Check HRV status
                    status = check_hrv_status(current_rmssd, previous_rmssd)

                    # Track status
                    status_counts[status] += 1

                    # Display feedback
                    display_feedback(status, current_rmssd, previous_rmssd, window_count)

                    # Update previous RMSSD
                    previous_rmssd = current_rmssd
                else:
                    print(f"\n[Window #{window_count}] Unable to calculate HRV")

            # Stop after all due windows are computed
            if data_time >= duration:
                if (
                    data_time >= WINDOW_SIZE_SEC and
                    duration - last_calculation_time >= UPDATE_INTERVAL_SEC / 2 and
                    len(ppg_buffer) >= window_size_samples * 0.8
                ):
                    window_count += 1
                    # Use the last buffer as the final window
                    ppg_window = np.array(ppg_buffer)
                    if is_window_bad(ppg_window, SAMPLING_RATE, segment_sec=3, max_bad_segments=15):
                        print(f"\n[Window #{window_count}] Bad data detected (segment SQI). Skipping HRV.")
                    else:
                        current_rmssd, peaks_indices = calculate_hrv_rmssd(ppg_window, SAMPLING_RATE)
                        new_peaks = [i for i in peaks_indices if i > last_peak_sample]
                        if new_peaks:
                            last_peak_sample = max(new_peaks)
                        ppg_peaks_data_combined.extend(new_peaks)
                        if current_rmssd is not None:
                            status = check_hrv_status(current_rmssd, previous_rmssd)
                            status_counts[status] += 1
                            display_feedback(status, current_rmssd, previous_rmssd, window_count)
                            previous_rmssd = current_rmssd
                        else:
                            print(f"\n[Window #{window_count}] Unable to calculate HRV")
                print("\n\nRecording complete!")
                break

            # Check if BLE thread is still running
            if not ble_thread.is_alive():
                print("\n\nBLE connection lost!")
                break

        # Stop BLE thread
        stop_event.set()
        ble_thread.join(timeout=5)

        # Final summary
        print("\n" + "="*60)
        print("SESSION SUMMARY")
        print("="*60)
        print(f"Total samples collected: {len(all_ppg_data)}")
        print(f"Total HRV windows analyzed: {window_count}")
        if previous_rmssd:
            print(f"Final RMSSD: {previous_rmssd:.2f} ms")
        print(f"\nStatus Distribution:")
        print(f"  GREEN (Improving):        {status_counts[0]} windows")
        print(f"  YELLOW (Minor decrease):  {status_counts[1]} windows")
        print(f"  RED (Significant drop):   {status_counts[2]} windows")
        print("="*60)

    except KeyboardInterrupt:
        print("\n\nRecording stopped by user")
        stop_event.set()
        ble_thread.join(timeout=5)

    except Exception as e:
        print(f"\nUnexpected error: {e}")
        stop_event.set()
        ble_thread.join(timeout=5)
        print(f"  RED (Significant drop):   {status_counts[2]} windows")
        print("="*60)
    
    except KeyboardInterrupt:
        print("\n\nRecording stopped by user")
        stop_event.set()
        ble_thread.join(timeout=5)
    
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        stop_event.set()
        ble_thread.join(timeout=5)


def main():
    """Main entry point"""
    results_path = os.path.join(os.path.dirname(__file__), "results.txt")

    with open(results_path, "w", encoding="utf-8") as results_file:
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        sys.stdout = TeeStdout(sys.stdout, results_file)
        sys.stderr = TeeStdout(sys.stderr, results_file)
        try:
            # Get user input
            device_address, duration = get_user_input()
            
            if device_address is None:
                print("\nExiting...")
                return
            
            # Confirm settings
            print(f"\n{'='*60}")
            print("CONFIGURATION")
            print(f"{'='*60}")
            print(f"BLE Device: {device_address}")
            print(f"Duration: {duration} seconds ({duration/60:.1f} minutes)")
            print(f"{'='*60}")
            
            confirm = input("\nStart recording? (y/n): ").strip().lower()
            if confirm != 'y':
                print("Cancelled.")
                return
            
            # Start collection and analysis
            collect_and_analyze_hrv(device_address, duration)
            
            print("\nSession complete. Thank you!")
        finally:
            sys.stdout = original_stdout
            sys.stderr = original_stderr

    # output the ppg data to a txt file
    with open("ppg_data.txt", "w") as f:
        for ppg_value in all_ppg_data:
            f.write(f"{ppg_value}\n")

    with open("ppg_window_data.txt", "w") as f:
        for ppg_value in ppg_window_data_combined:
            f.write(f"{ppg_value}\n")
    
    with open("ppg_peaks_data.txt", "w") as f:
        for peak_index in ppg_peaks_data_combined:
            f.write(f"{peak_index}\n")


if __name__ == "__main__":
    main()