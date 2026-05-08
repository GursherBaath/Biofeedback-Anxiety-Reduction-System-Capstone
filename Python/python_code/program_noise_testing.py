# ---------------------------------------------------------------------------
# Peak cleaning utility
# ---------------------------------------------------------------------------

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
import threading
import queue as queue_module
import time
from collections import deque
import numpy as np
import neurokit2 as nk
import warnings
import matplotlib.pyplot as plt

warnings.filterwarnings('ignore')


# ---------------------------------------------------------------------------
# TeeStdout – same as program.py
# ---------------------------------------------------------------------------

class TeeStdout:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)

    def flush(self):
        for stream in self.streams:
            stream.flush()


# ---------------------------------------------------------------------------
# HRV helpers – identical to program.py
# ---------------------------------------------------------------------------

def calculate_hrv_rmssd(ppg_window, sampling_rate=100):
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
        cleaned_peaks = clean_peaks(ppg_window, peaks_indices)

        # Create a new PPG_Peaks array with only cleaned peaks
        ppg_peaks_clean = np.zeros(len(ppg_window), dtype=int)
        for idx in cleaned_peaks:
            if 0 <= idx < len(ppg_peaks_clean):
                ppg_peaks_clean[idx] = 1

        # Replace the peaks in the signals DataFrame
        signals['PPG_Peaks'] = ppg_peaks_clean

        # Now calculate HRV using only the cleaned peaks
        hrv_metrics = nk.ppg_intervalrelated(signals, sampling_rate=sampling_rate)
        rmssd = hrv_metrics['HRV_RMSSD'].values[0]

        window_start_index = appended_samples - len(ppg_window)
        cleaned_peaks = [i + window_start_index for i in cleaned_peaks]
        return rmssd, cleaned_peaks
    except Exception as e:
        print(f"\n[WARNING] HRV calculation failed: {e}")
        return None, []


def check_hrv_status(current_rmssd, previous_rmssd):
    if previous_rmssd is None or current_rmssd is None:
        return 1
    change = current_rmssd - previous_rmssd
    if change >= 0:
        return 0
    elif change > -5:
        return 1
    else:
        return 2


def display_feedback(status, current_rmssd, previous_rmssd, window_number):
    status_info = {
        0: {"symbol": "✓", "color": "GREEN",  "message": "EXCELLENT - HRV IMPROVING"},
        1: {"symbol": "~", "color": "YELLOW", "message": "GOOD - SLIGHT DECREASE"},
        2: {"symbol": "✗", "color": "RED",    "message": "REFOCUS - SIGNIFICANT DROP"},
    }
    info = status_info.get(status, status_info[1])

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


# ---------------------------------------------------------------------------
# Noise-filtering functions – ITERATE ON THESE
# ---------------------------------------------------------------------------

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
    
    # Low peak-to-peak range - More effective variance check
    if np.ptp(seg) < 80:  # peak-to-peak range too small
        print("[DEBUG] Segment failed low peak-to-peak range check")
        return True

    # Hitting sensor limits - Hard Thresholding (0 to 4000)
    if np.any(seg == 0) or np.any(seg >= 4000): 
        print("[DEBUG] Segment failed sensor limit check")
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

    # Noise has high path length (sum of absolute differences)
    path_length = np.sum(np.abs(np.diff(seg)))
    if path_length > 12000: # experimentally determined
        print("[DEBUG] Segment failed path length check")
        '''plt.plot(seg)
        plt.ylim(0, 4000)
        plt.title("High Path Length Segment: " + f"{path_length:.0f}")
        plt.show()'''
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
            print(f"[DEBUG] Segment failed peak plausibility check")
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


# ---------------------------------------------------------------------------
# File-based data source  (replaces BLE thread)
# ---------------------------------------------------------------------------

def _file_stream_thread(file_path, data_queue, stop_event, connected_event,
                        sampling_rate=100, realtime=False):
    """
    Read one integer per line from file_path and push values into data_queue,
    mirroring what _ble_stream_thread does for live data.

    realtime=True  → sleep 1/sampling_rate between samples (actual speed)
    realtime=False → push as fast as possible (good for quick iteration)
    """
    try:
        with open(file_path, 'r') as f:
            lines = [l.strip() for l in f if l.strip()]
    except Exception as e:
        print(f"\n[ERROR] Could not open file: {e}")
        return

    connected_event.set()

    interval = 1.0 / sampling_rate if realtime else 0.0

    for line in lines:
        if stop_event.is_set():
            break
        try:
            data_queue.put(int(line))
        except ValueError:
            pass  # skip non-integer lines
        if interval:
            time.sleep(interval)

    # Signal end-of-file by setting the stop event so the main loop exits
    stop_event.set()


# ---------------------------------------------------------------------------
# Main collection / analysis loop  (mirrors collect_and_analyze_hrv)
# ---------------------------------------------------------------------------

def collect_and_analyze_from_file(file_path, duration, realtime=False):
    SAMPLING_RATE = 100
    WINDOW_SIZE_SEC = 30
    UPDATE_INTERVAL_SEC = 10

    window_size_samples = WINDOW_SIZE_SEC * SAMPLING_RATE

    data_queue = queue_module.Queue()
    stop_event = threading.Event()
    connected_event = threading.Event()

    file_thread = threading.Thread(
        target=_file_stream_thread,
        args=(file_path, data_queue, stop_event, connected_event),
        kwargs={"sampling_rate": SAMPLING_RATE, "realtime": realtime},
        daemon=True,
    )

    try:
        print(f"\n{'='*60}")
        print(f"Loading file: {file_path}")
        file_thread.start()

        if not connected_event.wait(timeout=10):
            print("Failed to open file.")
            stop_event.set()
            return

        mode_str = "real-time (100 Hz)" if realtime else "as fast as possible"
        print(f"File loaded. Replaying in {mode_str} mode.")
        print(f"Duration cap: {duration} seconds")
        print(f"HRV calculated every 10 s using 30-second windows")
        print(f"{'='*60}\n")

        ppg_buffer = deque(maxlen=window_size_samples)
        global all_ppg_data, ppg_window_data_combined, ppg_peaks_data_combined, appended_samples
        all_ppg_data = []
        ppg_window_data_combined = []
        ppg_peaks_data_combined = []
        appended_samples = 0

        last_peak_sample = -1  # Track last sample index for which a peak was added
        last_calculation_time = 0.0
        previous_rmssd = None
        window_count = 0
        sample_count = 0
        status_counts = {0: 0, 1: 0, 2: 0}

        while True:
            # Drain the queue
            try:
                while True:
                    ppg_value = data_queue.get_nowait()
                    ppg_buffer.append(ppg_value)
                    all_ppg_data.append(ppg_value)
                    sample_count += 1

                    if sample_count % 100 == 0:
                        data_time = sample_count / SAMPLING_RATE
                        print(f"Samples: {sample_count} | Time: {data_time:.1f}s", end='\r')
            except queue_module.Empty:
                pass

            time.sleep(0.001)  # yield CPU

            data_time = sample_count / SAMPLING_RATE

            # HRV every 10 s after initial 30 s window.
            # Use a while loop so fast-mode (no sleep) catches up on all
            # missed 10-second intervals in one outer iteration.
            while (data_time >= WINDOW_SIZE_SEC
                    and data_time - last_calculation_time >= UPDATE_INTERVAL_SEC):

                next_calc_time = last_calculation_time + UPDATE_INTERVAL_SEC
                last_calculation_time = next_calc_time  # always advance first

                # Skip early intervals that don't yet have a full window
                if next_calc_time < WINDOW_SIZE_SEC:
                    continue

                window_count += 1

                # Extract the exact 30-second slice from the collected data
                window_end_sample = int(next_calc_time * SAMPLING_RATE)
                window_start_sample = window_end_sample - window_size_samples
                if window_start_sample < 0 or window_end_sample > len(all_ppg_data):
                    continue
                ppg_window = np.array(all_ppg_data[window_start_sample:window_end_sample])

                if is_window_bad(ppg_window, SAMPLING_RATE, segment_sec=3, max_bad_segments=0):
                    print(f"\n[Window #{window_count}] Bad data detected (segment SQI). Skipping HRV.")
                    continue

                current_rmssd, cleaned_peaks = calculate_hrv_rmssd(ppg_window, SAMPLING_RATE)
                # Only add peaks that are after the last_peak_sample
                new_peaks = [i for i in cleaned_peaks if i > last_peak_sample]
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

            # Stop when duration is reached or file exhausted
            if data_time >= duration or (stop_event.is_set() and data_queue.empty()):
                print("\n\nPlayback complete!")
                break

        stop_event.set()
        file_thread.join(timeout=5)

        print("\n" + "="*60)
        print("SESSION SUMMARY")
        print("="*60)
        print(f"Total samples replayed: {len(all_ppg_data)}")
        print(f"Total HRV windows analyzed: {window_count}")
        if previous_rmssd:
            print(f"Final RMSSD: {previous_rmssd:.2f} ms")
        print(f"\nStatus Distribution:")
        print(f"  GREEN (Improving):        {status_counts[0]} windows")
        print(f"  YELLOW (Minor decrease):  {status_counts[1]} windows")
        print(f"  RED (Significant drop):   {status_counts[2]} windows")
        print("="*60)

    except KeyboardInterrupt:
        print("\n\nStopped by user")
        stop_event.set()
        file_thread.join(timeout=5)
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        stop_event.set()
        file_thread.join(timeout=5)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def get_user_input_for_testing():
    """Prompt for file path, duration, and playback mode."""
    print("\n" + "="*60)
    print("PPG NOISE TESTING HARNESS")
    print("="*60)

    # Gather file options


    base_dir = os.path.dirname(__file__)
    default_file_root = os.path.join(base_dir, "ppg_data.txt")
    default_file_dataset = os.path.join(base_dir, "ppg_dataset", "ppg_data.txt")
    output_dir = os.path.join(base_dir, "output_filter_testing")
    old_dir = os.path.join(base_dir, "old")
    ppg_dataset_dir = os.path.join(base_dir, "ppg_dataset")

    # List files in output_filter_testing (exclude peaks/windows/results)

    # Allow selection of ppg_data.txt in root and any .txt in ppg_dataset
    file_options = [(default_file_root, "ppg_data.txt (default)")]
    ppg_dataset_files = [f for f in os.listdir(ppg_dataset_dir) if f.endswith('.txt')]
    for f in ppg_dataset_files:
        file_options.append((os.path.join(ppg_dataset_dir, f), f"ppg_dataset/{f}"))

    print("\nSelect a PPG data file:")
    for idx, (_, label) in enumerate(file_options, 1):
        print(f"  {idx}. {label}")
    selection = input(f"Enter number [default {len(file_options)}]: ").strip()
    try:
        if selection:
            sel_idx = int(selection) - 1
            if sel_idx < 0 or sel_idx >= len(file_options):
                print("Invalid selection.")
                return None, None, None
            file_path = file_options[sel_idx][0]
        else:
            file_path = file_options[-1][0]
    except Exception:
        print("Invalid input.")
        return None, None, None

    if not os.path.isfile(file_path):
        print(f"File not found: {file_path}")
        return None, None, None

    with open(file_path) as f:
        num_samples = sum(1 for l in f if l.strip())
    suggested_duration = num_samples // 100
    print(f"  File contains ~{num_samples} samples (~{suggested_duration}s at 100 Hz)")

    duration_input = input(f"\nDuration in seconds to process [{suggested_duration}]: ").strip()
    try:
        duration = int(duration_input) if duration_input else suggested_duration
        if duration < 30:
            print("Need at least 30 seconds for HRV calculation.")
            return None, None, None
    except ValueError:
        print("Invalid duration.")
        return None, None, None

    realtime_input = input("\nRealtime playback at 100 Hz? (y/n) [n for fastest]: ").strip().lower()
    realtime = realtime_input == 'y'

    return file_path, duration, realtime


def main():
    output_dir = os.path.join(os.path.dirname(__file__), "output_filter_testing")
    os.makedirs(output_dir, exist_ok=True)
    results_path = os.path.join(output_dir, "results_noise_testing.txt")

    with open(results_path, "w", encoding="utf-8") as results_file:
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        sys.stdout = TeeStdout(sys.stdout, results_file)
        sys.stderr = TeeStdout(sys.stderr, results_file)
        try:
            file_path, duration, realtime = get_user_input_for_testing()

            if file_path is None:
                print("\nExiting...")
                return

            print(f"\n{'='*60}")
            print("CONFIGURATION")
            print(f"{'='*60}")
            print(f"File:     {file_path}")
            print(f"Duration: {duration}s ({duration/60:.1f} min)")
            print(f"Mode:     {'real-time' if realtime else 'fast (no sleep)'}")
            print(f"{'='*60}")

            confirm = input("\nStart? (y/n) [y]: ").strip().lower()
            if confirm and confirm != 'y':
                print("Cancelled.")
                return

            collect_and_analyze_from_file(file_path, duration, realtime)

            print("\nDone!")
        finally:
            sys.stdout = original_stdout
            sys.stderr = original_stderr

    # Always write output files to output_filter_testing
    with open(os.path.join(output_dir, "ppg_window_data.txt"), "w") as f:
        for v in ppg_window_data_combined:
            f.write(f"{v}\n")

    with open(os.path.join(output_dir, "ppg_peaks_data.txt"), "w") as f:
        for idx in ppg_peaks_data_combined:
            f.write(f"{idx}\n")
    
    # for graphing bad segments in plot_realtime_data_ericas_version.py
    '''with open(os.path.join(output_dir, "detected_bad_segments.txt"), "w") as f:
        for seg in ppg_window_data_combined:
            f.write(f"{seg}\n")'''

    # Always output a copy of the input ppg_data.txt to output_filter_testing
    if os.path.basename(file_path) == "ppg_data.txt":
        out_path = os.path.join(output_dir, "ppg_data.txt")
        with open(file_path, "r") as fin, open(out_path, "w") as fout:
            for line in fin:
                fout.write(line)


if __name__ == "__main__":
    main()
