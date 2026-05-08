"""
HR Amplitude Monitoring — Real-time HRV Biofeedback
====================================================

Purpose
-------
Measures respiratory sinus arrhythmia (RSA) amplitude in real time by
streaming PPG data from a custom BLE sensor, computing heart rate (HR),
and tracking the natural rise-and-fall (peak-to-trough) of HR that is
caused by breathing. A large peak-to-trough amplitude indicates strong
HRV coherence and is the primary biofeedback metric.

Data Flow Overview (for API/app design)
----------------------------------------
1. BLE sensor (NanoESP32_PPG) streams raw PPG samples as comma-separated
   ASCII integers over BLE UART notifications at 100 Hz.
2. Samples are buffered in a 10-second rolling FIFO.
3. Every 1 second (100 samples), the rolling buffer is processed:
     a. NeuroKit2 detects PPG systolic peaks (cardiac beats).
     b. Custom cleaning removes false peaks (rising-edge artefacts,
        duplicate peaks that are too close together).
     c. Inter-beat intervals (IBIs) are computed from cleaned peak indices;
        physiological range filter: 0.3 s – 2.0 s (30–200 bpm).
     d. Mean IBI → instantaneous HR (BPM), appended to hr_values list.
4. A separate signal-quality check (SQI) runs on a sliding 3-second window
   of raw PPG on every new sample. If the window is bad, HR computation and
   amplitude tracking pause until the signal recovers.
5. RealTimeHRVAmplitude.update() scans the growing hr_values list for
   RSA peaks (local HR maxima) and RSA troughs (local HR minima), pairs
   each trough with the preceding peak, and emits an amplitude event.

Key Outputs emitted per amplitude event (~every 1–2 breathing cycles)
----------------------------------------------------------------------
  hr         (float, BPM)   — latest instantaneous heart rate
  amplitude  (float, BPM)   — 3-sample smoothed RSA peak-to-trough HR
                               swing; higher = stronger HRV coherence
  breathing_rate_bpm (float) — estimated breathing rate derived from the
                               half-cycle duration (peak-time → trough-time)
  signal_quality     (str)  — "ACTIVE" | "PAUSED (bad signal)"
  feedback_color     (str)  — "green" (amplitude ≥ previous),
                               "yellow" (within 10% decrease),
                               "red" (>10% decrease)

Phone App UI Screens Required
------------------------------
  1. Device scan screen  — lists discovered BLE devices named
                           "NanoESP32_PPG"; user selects one.
  2. Session config      — user enters recording duration (min 30 s).
  3. Real-time dashboard — displays three live charts updated ~1 Hz:
       • HR line chart (BPM vs. time) with red ▲ markers at RSA peaks
         and blue ▼ markers at RSA troughs; purple ↕ annotation showing
         the amplitude value for each breath cycle.
       • RSA Amplitude chart (BPM vs. time, smoothed, 3-sample window).
       • Breathing Rate chart (breaths per minute vs. time).
     Also shows: session progress bar, signal-quality badge, current HR
     value, latest amplitude in a colour-coded circle (green/yellow/red).
  4. Session summary     — displayed after recording ends;
       mean/min/max HR, mean/min/max amplitude, mean breathing rate,
       total amplitude events, total samples collected.
  5. Post-session waveform viewer (optional) — scrollable raw PPG signal
     with detected cardiac peaks overlaid; supports pan/zoom.

Saved Output File
-----------------
  ppg_data.txt     — raw PPG integer samples, one value per line.
  hramp_results.txt — full console log of the session (mirrored stdout).

Dependencies
------------
  bleak, neurokit2, scipy, numpy, matplotlib (TkAgg backend)
"""

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
from scipy.signal import butter, filtfilt, find_peaks
from scipy.fft import rfft, rfftfreq
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button
import warnings

warnings.filterwarnings('ignore')


# ─────────────────────────────────────────────────────────────
# PPG Peak Cleaning
#
# Raw peak detectors (e.g. NeuroKit2) frequently produce false positives
# on the rising edge of a pulse or clustered near the true peak. These
# two-stage helpers remove those artefacts before IBI / HR calculation.
# ─────────────────────────────────────────────────────────────

def clean_peaks(ppg_window, peak_indices, rising_window=5, min_distance=20):
    """
    Two-stage PPG peak cleaner.

    Stage 1 — rising-edge filter (initial_cleaning):
        Discard any peak whose immediately following samples are all
        strictly increasing, indicating the detector fired too early on
        the ascending slope rather than at the true systolic peak.

    Stage 2 — minimum-distance filter:
        Walk the remaining peaks in order. If two consecutive peaks are
        closer than min_distance samples (default 20 = 200 ms at 100 Hz,
        ~300 bpm max), keep only the higher-amplitude one.

    Args:
        ppg_window   (list or array): raw PPG samples (any length).
        peak_indices (list of int):   sample indices of candidate peaks
                                      within ppg_window.
        rising_window (int): number of samples after a peak to check for
                             a monotonic rise (default 5 = 50 ms).
        min_distance  (int): minimum allowed gap between two peaks in
                             samples (default 20 = 200 ms at 100 Hz).

    Returns:
        list of int: cleaned peak indices, sorted ascending.
    """
    cleaned = initial_cleaning(ppg_window, peak_indices, rising_window)
    i = 0
    while i < len(cleaned) - 1:
        if cleaned[i+1] - cleaned[i] < min_distance:
            if ppg_window[cleaned[i]] >= ppg_window[cleaned[i+1]]:
                cleaned.pop(i+1)
            else:
                cleaned.pop(i)
        else:
            i += 1
    return cleaned


def initial_cleaning(ppg_window, peak_indices, rising_window=5):
    """
    Remove peaks that sit on a rising edge (stage 1 of clean_peaks).

    A candidate peak is rejected if every one of the next `rising_window`
    samples is strictly greater than the one before it, which indicates
    the sample is on the ascending slope, not at the true local maximum.

    Args:
        ppg_window   (list or array): raw PPG samples.
        peak_indices (list of int):   candidate peak indices.
        rising_window (int): look-ahead length in samples (default 5).

    Returns:
        list of int: surviving peak indices.
    """
    cleaned = []
    for idx in peak_indices:
        end_idx = min(idx + rising_window + 1, len(ppg_window))
        after = ppg_window[idx:end_idx]
        if len(after) > 1 and all(after[i] < after[i+1] for i in range(len(after)-1)):
            continue
        cleaned.append(idx)
    return cleaned


# ─────────────────────────────────────────────────────────────
# BLE Device Configuration
#
# The sensor is an Arduino Nano ESP32 running custom firmware that
# advertises under the name below and exposes a Nordic UART Service (NUS).
# TX_CHAR_UUID is the NUS TX characteristic (sensor → phone/PC);
# the phone app must subscribe to notifications on this characteristic
# to receive the PPG data stream.
#
# Data format: BLE notifications arrive as UTF-8 text containing one or
# more comma-separated integer PPG ADC values followed by a newline, e.g.:
#   "2048,2051,2049,2055\n"
# Each integer is one 12-bit ADC sample (range 0–4095). The sensor sends
# values at approximately 100 Hz (100 samples per second).
# ─────────────────────────────────────────────────────────────
BLE_DEVICE_NAME = "NanoESP32_PPG"  # BLE advertisement name to match during scan
TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  # Nordic UART Service TX characteristic

# ─────────────────────────────────────────────────────────────
# Amplitude Trend Feedback — Colour Thresholds
#
# After every amplitude event the new amplitude is compared to the
# previous one to give the user instant trend feedback:
#
#   GREEN  — amplitude is equal to or greater than previous (improving/stable)
#   YELLOW — amplitude dropped by less than (1 - AMP_YELLOW_THRESHOLD) = 10%
#   RED    — amplitude dropped by 10% or more (significant decrease)
#
# Phone app equivalent: render the current amplitude value (or a circular
# gauge / ring) in the corresponding colour. The same logic applies:
#   if amp >= prev_amp                    → green
#   elif amp >= prev_amp * threshold      → yellow
#   else                                  → red
# ─────────────────────────────────────────────────────────────
AMP_YELLOW_THRESHOLD = 0.90  # amplitude ratio below which feedback turns yellow (10% drop)

# ANSI colour codes used in the terminal console output.
# The phone app should map these states to actual UI colours instead.
_ANSI_GREEN  = '\033[92m'
_ANSI_YELLOW = '\033[93m'
_ANSI_RED    = '\033[91m'
_ANSI_RESET  = '\033[0m'


# ─────────────────────────────────────────────────────────────
# Utility — Dual-output stdout wrapper
# ─────────────────────────────────────────────────────────────

class TeeStdout:
    """
    Forwards all writes to multiple output streams simultaneously.
    Used in main() to mirror console output to hramp_results.txt at the
    same time as printing to the terminal. Not needed in a phone app;
    the app's logging layer replaces this.
    """
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)

    def flush(self):
        for stream in self.streams:
            stream.flush()


# ─────────────────────────────────────────────────────────────
# RSA Amplitude Tracker
#
# Respiratory sinus arrhythmia (RSA) causes heart rate to rise during
# inhalation and fall during exhalation. This class tracks that
# oscillation on the ~1 Hz HR time series and reports the amplitude
# (peak HR − trough HR) as the primary biofeedback metric.
# ─────────────────────────────────────────────────────────────

class RealTimeHRVAmplitude:
    """
    Incrementally detects RSA peaks and troughs in the HR time series
    and emits an amplitude event each time a valid peak→trough pair is
    confirmed.

    The tracker is stateful: it remembers the last unmatched peak across
    successive calls to update() so that peak/trough pairs that span two
    processing cycles are still captured correctly.

    State attributes (relevant for serialisation / API session state):
        last_peak_idx    (int | None)  — hr_values index of the last
                                         unmatched RSA HR peak.
        last_peak_hr     (float | None)— HR value (BPM) at that peak.
        amplitudes       (list[float]) — running history of raw
                                         amplitude values for smoothing.
        last_confirmed_idx (int)       — highest hr_values index that has
                                         already been processed; prevents
                                         re-processing old events.
        paused           (bool)        — when True, update() is not called
                                         (set externally by SQI logic).

    HR values are appended roughly once per second (one per
    PROCESS_INTERVAL = 100 samples at 100 Hz).
    """

    def __init__(self):
        self.last_peak_idx = None
        self.last_peak_hr = None
        self.amplitudes = []           # running list for smoothing
        self.last_confirmed_idx = -1   # last hr_values index fully processed
        self.paused = False

    def reset_peak_state(self, hr_len=0):
        """
        Discard incomplete peak context after a prolonged bad-signal period.

        Called after BAD_RESET_DELAY seconds of continuous bad data so that
        a peak detected before the artefact cannot incorrectly pair with a
        trough detected after recovery (which would yield an invalid,
        possibly very large amplitude).

        Sets last_confirmed_idx to hr_len - 1 so that update() only
        processes HR samples collected *after* this point, effectively
        ignoring the entire pre-bad-segment history for future pairing.

        Args:
            hr_len (int): current length of the hr_values list at the
                          moment the reset is triggered. Pass 0 only if
                          hr_values is empty.
        """
        self.last_peak_idx = None
        self.last_peak_hr = None
        self.last_confirmed_idx = hr_len - 1

    def update(self, hr_times, hr_values):
        """
        Scan the HR time series for new RSA peak→trough pairs and return
        an amplitude event for each confirmed pair.

        Called once per processing cycle (~every 1 second). Only indices
        greater than last_confirmed_idx are evaluated, so the method is
        safe to call repeatedly on a growing list.

        Detection parameters:
            distance=4    — peaks/troughs must be at least 4 HR samples
                            (~4 s) apart; prevents noise from generating
                            spurious events at unrealistically fast rates.
            prominence=1.5— the peak/trough must stand out by at least
                            1.5 BPM from surrounding values.
            CONFIRM_MARGIN=3 — the last 3 samples of the HR array are not
                            yet confirmed (edge effect); they are skipped
                            until more data arrives.

        Args:
            hr_times  (list[float]): timestamps in seconds, one per HR
                                     sample, appended at ~1 Hz.
            hr_values (list[float]): heart rate in BPM, parallel to
                                     hr_times.

        Returns:
            list[dict]: one dict per new confirmed amplitude event, each
            containing:
                peak_idx          (int)   — index into hr_values/hr_times
                                           of the RSA HR peak (inhalation
                                           peak).
                trough_idx        (int)   — index of the following RSA HR
                                           trough (exhalation trough).
                peak_hr           (float) — HR value at peak (BPM).
                trough_hr         (float) — HR value at trough (BPM).
                amplitude         (float) — 3-sample smoothed
                                           peak_hr − trough_hr (BPM);
                                           the primary biofeedback metric.
                breathing_rate_bpm(float) — estimated breathing frequency
                                           in breaths per minute, derived
                                           from 60 / (2 × half_period)
                                           where half_period = trough_time
                                           − peak_time in seconds.
        """
        n = len(hr_values)
        if n < 10:
            return []

        hr = np.array(hr_values, dtype=float)
        CONFIRM_MARGIN = 3  # wait 3 samples before confirming an event

        peaks, _ = find_peaks(hr, distance=4, prominence=1.5)
        troughs, _ = find_peaks(-hr, distance=4, prominence=1.5)

        events = sorted(
            [(i, 'peak') for i in peaks] +
            [(i, 'trough') for i in troughs]
        )

        feedback = []
        for idx, event_type in events:
            if idx <= self.last_confirmed_idx:
                continue
            if idx >= n - CONFIRM_MARGIN:
                continue

            if event_type == 'peak':
                self.last_peak_idx = idx
                self.last_peak_hr = hr[idx]
                self.last_confirmed_idx = idx

            elif event_type == 'trough':
                self.last_confirmed_idx = idx
                if self.last_peak_hr is not None and self.last_peak_idx is not None:
                    amplitude = self.last_peak_hr - hr[idx]
                    if amplitude > 1.0:  # at least 1 BPM difference
                        self.amplitudes.append(amplitude)
                        smooth_amp = np.mean(self.amplitudes[-3:])

                        # Estimate breathing rate from the half-cycle duration.
                        # The peak → trough span equals half a breath cycle,
                        # so full_period = 2 × half_period; rate = 60 / period.
                        # Typical coherent breathing is 4–7 breaths/min (5–6
                        # breaths/min is the resonance frequency target).
                        peak_t = hr_times[self.last_peak_idx]
                        trough_t = hr_times[idx]
                        half_period = trough_t - peak_t
                        if half_period > 0:
                            breathing_rate = 60.0 / (2 * half_period)
                        else:
                            breathing_rate = 0

                        feedback.append({
                            'peak_idx': self.last_peak_idx,
                            'trough_idx': idx,
                            'peak_hr': float(self.last_peak_hr),
                            'trough_hr': float(hr[idx]),
                            'amplitude': smooth_amp,
                            'breathing_rate_bpm': breathing_rate,
                        })
                    self.last_peak_hr = None
                    self.last_peak_idx = None

        return feedback


# ─────────────────────────────────────────────────────────────
# Signal Quality Index (SQI)
#
# Runs on a sliding 3-second (300-sample) window of raw PPG on every
# new incoming sample. Returns True when the window should be rejected.
# When bad, the app must show a "poor signal" indicator and halt
# amplitude updates until the signal recovers.
# ─────────────────────────────────────────────────────────────

def is_segment_bad(segment, sampling_rate):
    """
    Heuristic signal quality check for a short PPG segment.

    Checks (in order; returns True on first failure):
      1. Empty segment.
      2. std < 1.0      — flat-line / sensor not contacting skin.
      3. unique_ratio < 0.02 — fewer than 2% unique values; stuck ADC
                            or heavily clipped signal.
      4. max |diff| > 2000  — single-sample spike > 2000 ADC counts;
                            indicates motion artefact or electrical noise.
      5. Peak count outside [2, 6] per 3-second window — corresponds to
         HR outside 40–120 bpm, or the detector completely failed. At
         100 Hz over 3 s a normal resting HR (60–80 bpm) yields 3–4 peaks.

    Args:
        segment      (array-like): raw PPG integer samples.
        sampling_rate (int):       samples per second (expected 100).

    Returns:
        bool: True if the segment is bad and should be discarded.
    """
    if len(segment) == 0:
        return True
    seg = np.asarray(segment, dtype=float)
    if np.std(seg) < 1.0:           # flat-line / sensor off skin
        return True
    unique_ratio = len(np.unique(seg)) / len(seg)
    if unique_ratio < 0.02:         # ADC stuck or signal clipped
        return True
    if np.max(np.abs(np.diff(seg))) > 2000:  # single-sample spike / motion
        return True
    try:
        peaks, _ = nk.ppg_peaks(seg, sampling_rate=sampling_rate)
        if "PPG_Peaks" in peaks:
            peak_count = int(np.sum(peaks["PPG_Peaks"]))
        else:
            peak_count = 0
        # Expect 2–6 beats in a 3-second window (40–120 bpm range)
        if peak_count < 2 or peak_count > 6:
            return True
    except Exception:
        return True
    return False


# ─────────────────────────────────────────────────────────────
# BLE Helpers
#
# scan_ble_devices  — discovers nearby BLE devices and filters to those
#                     whose advertisement name matches BLE_DEVICE_NAME.
#                     Phone app equivalent: a BLE scan with a name filter;
#                     return a list of {name, address, rssi} objects.
#
# parse_ppg_signal  — converts a raw BLE notification string (CSV ints)
#                     into a list of integer ADC samples.
#
# get_user_input    — CLI-only; the app replaces this with a UI flow:
#                     device-picker screen → duration input screen.
#
# _ble_stream_thread— runs the asyncio BLE client in a background thread
#                     and puts each incoming PPG integer into data_queue.
#                     Phone app equivalent: a BLE notification callback
#                     that passes samples directly to the processing layer.
# ─────────────────────────────────────────────────────────────

def scan_ble_devices(timeout=10):
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


def parse_ppg_signal(line):
    try:
        values = [int(v.strip()) for v in line.split(',') if v.strip()]
        return values if values else None
    except ValueError:
        return None


def get_user_input():
    print("\n" + "=" * 60)
    print("HR AMPLITUDE MONITORING - Real-Time Biofeedback")
    print("=" * 60)

    devices = scan_ble_devices()
    if not devices:
        return None, None

    if len(devices) == 1:
        device = devices[0]
        print(f"\nAuto-selected device: {device.name} ({device.address})")
    else:
        print("\nMultiple devices found:")
        for i, dev in enumerate(devices):
            print(f"  {i + 1}. {dev.name} ({dev.address})")
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

    duration_input = input(
        "\nEnter recording duration in seconds (e.g., 180 for 3 minutes): "
    ).strip()
    try:
        duration = int(duration_input)
        if duration < 30:
            print("Duration must be at least 30 seconds!")
            return None, None
    except ValueError:
        print("Invalid duration!")
        return None, None

    return device.address, duration


def _ble_stream_thread(device_address, data_queue, stop_event, connected_event):
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


# ─────────────────────────────────────────────────────────────
# Main Processing Loop — Collection + Real-Time Amplitude Analysis
#
# This is the core function driving the entire session. It manages:
#   • BLE sample ingestion (via background thread + queue)
#   • Sliding-window SQI checks on every new sample
#   • Per-second HR computation from PPG peaks
#   • RSA amplitude tracking via RealTimeHRVAmplitude
#   • Real-time matplotlib chart updates (desktop only)
#   • Session summary and data persistence
#
# Phone app equivalent: a session controller / ViewModel that subscribes
# to the BLE data stream and calls the processing pipeline on each batch.
# ─────────────────────────────────────────────────────────────

def collect_and_analyze_amplitude(device_address, duration):
    """
    Run a full recording session for `duration` seconds.

    Processing constants (tune these for the app if needed):
        SAMPLING_RATE   = 100   Hz  — must match sensor firmware
        SEGMENT_SEC     = 3     s   — SQI window length
        BUFFER_SEC      = 10    s   — rolling buffer for HR computation
        PROCESS_INTERVAL= 100 samples (~1 s) — HR update cadence
        BAD_RESET_DELAY = 4.0   s   — seconds of bad data before resetting
                                       incomplete peak state

    Real-time data series (phone app should maintain equivalent arrays
    or a time-series database for chart rendering):
        hr_times    list[float]  — timestamp (s) of each HR estimate
        hr_values   list[float]  — HR in BPM, parallel to hr_times
        amp_times   list[float]  — timestamp (s) of each amplitude event
        amp_values  list[float]  — smoothed RSA amplitude (BPM)
        bpm_values  list[float]  — breathing rate (bpm) per amplitude event

    Args:
        device_address (str): BLE MAC address of the sensor.
        duration       (int): recording length in seconds (minimum 30).
    """
    SAMPLING_RATE = 100     # sensor sample rate in Hz
    SEGMENT_SEC = 3         # SQI sliding-window length in seconds
    SEGMENT_SAMPLES = SEGMENT_SEC * SAMPLING_RATE   # 300 samples per SQI check
    BUFFER_SEC = 10         # rolling buffer length in seconds
    BUFFER_SAMPLES = BUFFER_SEC * SAMPLING_RATE
    PROCESS_INTERVAL = 100  # process every 1 s (100 samples at 100 Hz)

    data_queue = queue_module.Queue()
    stop_event = threading.Event()
    connected_event = threading.Event()

    all_ppg_data = []             # complete raw PPG record (all samples, saved to file)
    all_detected_peaks = set()   # global sample indices of all detected cardiac peaks
                                 # (used for post-session deduplication and viewer)
    ppg_buffer = deque(maxlen=BUFFER_SAMPLES)  # 10-second rolling window for HR computation

    tracker = RealTimeHRVAmplitude()

    # ── Real-time plot setup (desktop matplotlib dashboard) ──────────────
    # The phone app replaces this section with three live chart components:
    #   Chart 1 (ax_hr):  HR vs. time line chart with RSA peak (▲) and
    #                     trough (▼) markers and purple ↕ amplitude labels.
    #   Chart 2 (ax_amp): Smoothed RSA amplitude vs. time.
    #   Chart 3 (ax_bpm): Estimated breathing rate vs. time.
    # All three charts share the same x-axis (time in seconds).
    # Vertical grey dashed lines mark bad-segment events on all charts.
    plt.ion()
    fig, (ax_hr, ax_amp, ax_bpm) = plt.subplots(3, 1, figsize=(12, 9), sharex=True)
    fig.suptitle('Real-Time HR Amplitude Biofeedback')

    # Accumulated time-series data for chart rendering.
    # Phone app: store these or equivalent in state/ViewModel.
    hr_times = []           # seconds; ~1 Hz; x-axis for HR chart
    hr_values = []          # BPM;     ~1 Hz; y-axis for HR chart
    amp_times = []          # seconds; per breath cycle; x-axis for amplitude/bpm charts
    amp_values = []         # BPM;     smoothed RSA amplitude; y-axis for amplitude chart
    bpm_values = []         # breaths/min; y-axis for breathing rate chart
    bad_segment_times = []  # seconds; timestamps of bad-segment transitions (for markers)

    line_hr, = ax_hr.plot([], [], 'g-o', markersize=3, label='Heart Rate')
    peak_markers, = ax_hr.plot([], [], '^', color='red', markersize=8,
                                label='Breathing Peak')
    trough_markers, = ax_hr.plot([], [], 'v', color='blue', markersize=8,
                                  label='Breathing Trough')
    ax_hr.set_ylabel('Heart Rate (BPM)')
    ax_hr.legend(loc='upper left', fontsize=7)
    ax_hr.grid(True, alpha=0.3)

    # Breathing cycle marker data for the HR chart.
    # Phone app: use these to overlay ▲/▼ annotations on the HR line chart.
    breath_peak_times = []   # time (s) of each RSA HR peak (start of exhalation)
    breath_peak_hrs = []     # HR (BPM) at each RSA peak
    breath_trough_times = [] # time (s) of each RSA HR trough (end of exhalation)
    breath_trough_hrs = []   # HR (BPM) at each RSA trough
    # Queued amplitude span annotations: (peak_t, trough_t, peak_hr, trough_hr, amplitude).
    # Each tuple drives a ↕ arrow + label drawn between the peak and trough on the HR chart.
    pending_amp_annotations = []

    line_amp, = ax_amp.plot([], [], 'b-o', markersize=4, label='Amplitude')
    ax_amp.set_ylabel('Peak-to-Trough Amplitude')
    ax_amp.legend(loc='upper left')
    ax_amp.grid(True, alpha=0.3)

    line_bpm, = ax_bpm.plot([], [], 'r-x', markersize=4, label='Breathing Rate')
    ax_bpm.set_ylabel('Breathing Rate (BPM)')
    ax_bpm.set_xlabel('Time (s)')
    ax_bpm.legend(loc='upper left')
    ax_bpm.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.show(block=False)
    plt.pause(0.01)

    ble_thread = threading.Thread(
        target=_ble_stream_thread,
        args=(device_address, data_queue, stop_event, connected_event),
        daemon=True,
    )

    try:
        print(f"\n{'=' * 60}")
        print(f"Connecting to BLE device {device_address}...")
        ble_thread.start()

        if not connected_event.wait(timeout=30):
            print("Failed to connect within 30 seconds.")
            stop_event.set()
            return

        print(f"Connected! Recording for {duration}s")
        print(f"Processing every {PROCESS_INTERVAL / SAMPLING_RATE:.1f}s "
              f"on a {BUFFER_SEC}s rolling buffer")
        print(f"{'=' * 60}\n")

        sample_count = 0
        last_process_count = 0
        is_paused = False
        bad_start_time = None    # time (s) when bad data began
        peak_state_reset = False # whether reset has fired this bad period
        BAD_RESET_DELAY = 4.0   # seconds of bad data before discarding peak state

        # Sliding window buffer for SQI — runs on every new sample once full
        segment_buffer = deque(maxlen=SEGMENT_SAMPLES)
        need_plot_update = False

        while True:
            # Drain the BLE queue
            try:
                while True:
                    ppg_value = data_queue.get_nowait()
                    ppg_buffer.append(ppg_value)
                    all_ppg_data.append(ppg_value)
                    segment_buffer.append(ppg_value)
                    sample_count += 1

                    if sample_count % 100 == 0:
                        # Status tick every 100 samples (1 second).
                        # Phone app: update a session progress bar and
                        # signal-quality badge using these same values.
                        t = sample_count / SAMPLING_RATE
                        status = "PAUSED (bad signal)" if is_paused else "ACTIVE"
                        print(f"  Samples: {sample_count} | "
                              f"Time: {t:.1f}s | Status: {status}",
                              end='\r')

                    # ── Sliding-window SQI check (fires on every sample once
                    #    the buffer holds a full SEGMENT_SEC window) ──
                    if len(segment_buffer) == SEGMENT_SAMPLES:
                        seg = np.array(segment_buffer)
                        t = sample_count / SAMPLING_RATE

                        if is_segment_bad(seg, SAMPLING_RATE):
                            if not is_paused:
                                # Transition: good → bad. Pause tracking but
                                # preserve peak state in case signal recovers
                                # quickly (within BAD_RESET_DELAY seconds).
                                print(f"\n[{t:.1f}s] !! BAD SEGMENT detected — "
                                      f"amplitude tracking PAUSED")
                                bad_segment_times.append(t)
                                is_paused = True
                                tracker.paused = True
                                bad_start_time = t
                                peak_state_reset = False
                            elif not peak_state_reset and (t - bad_start_time) >= BAD_RESET_DELAY:
                                # Bad data has persisted long enough — any
                                # pending peak can no longer pair with a trough.
                                print(f"\n[{t:.1f}s] Bad data persisted "
                                      f"{BAD_RESET_DELAY:.0f}s — peak state RESET")
                                tracker.reset_peak_state(len(hr_values))
                                peak_state_reset = True
                        else:
                            if is_paused:
                                print(f"\n[{t:.1f}s] Signal recovered — "
                                      f"amplitude tracking RESUMED")
                                is_paused = False
                                tracker.paused = False
                                bad_start_time = None
                                peak_state_reset = False

            except queue_module.Empty:
                pass

            time.sleep(0.01)

            data_time = sample_count / SAMPLING_RATE

            # ── Process every PROCESS_INTERVAL samples (~1 s) ──
            if (sample_count - last_process_count >= PROCESS_INTERVAL
                    and len(ppg_buffer) >= SAMPLING_RATE * 5
                    and not is_paused):

                last_process_count = sample_count
                buf_array = np.array(ppg_buffer)
                # Global index of buffer[0]
                buffer_start = sample_count - len(buf_array)

                # ── Step 1: Compute Heart Rate from PPG peaks ─────────────
                # a. NeuroKit2 processes the 10-second PPG buffer and returns
                #    a boolean peak column ('PPG_Peaks') in the signals DataFrame.
                # b. clean_peaks() removes false positives (rising-edge artefacts
                #    and duplicates too close together).
                # c. IBIs (inter-beat intervals) are computed from consecutive
                #    cleaned peak indices; filtered to 0.3–2.0 s (30–200 bpm).
                # d. Mean IBI → HR in BPM, appended to hr_times/hr_values.
                # Phone app: replace with an equivalent peak detection + IBI
                # → HR pipeline in Swift/Kotlin using the same constants.
                try:
                    signals, info = nk.ppg_process(buf_array,
                                                   sampling_rate=SAMPLING_RATE)
                    if 'PPG_Peaks' in signals:
                        raw_peaks = list(
                            np.where(signals['PPG_Peaks'] == 1)[0])
                    else:
                        raw_peaks = []

                    cleaned = clean_peaks(buf_array, raw_peaks)

                    # Convert buffer-local peak indices to global sample indices
                    # for the post-session PPG viewer.
                    for pk in cleaned:
                        all_detected_peaks.add(buffer_start + pk)

                    if len(cleaned) >= 2:
                        ibi = np.diff(cleaned) / SAMPLING_RATE  # inter-beat intervals in seconds
                        ibi = ibi[(ibi > 0.3) & (ibi < 2.0)]   # valid HR range: 30–200 bpm
                        if len(ibi) > 0:
                            avg_hr = 60.0 / np.mean(ibi)
                            t_hr = sample_count / SAMPLING_RATE
                            hr_times.append(t_hr)
                            hr_values.append(avg_hr)
                            need_plot_update = True
                except Exception:
                    pass

                # ── Step 2: RSA Amplitude from HR peaks/troughs ──────────
                # tracker.update() scans the growing hr_times/hr_values lists
                # for new RSA peak→trough pairs and returns an event dict for
                # each confirmed breath cycle (see RealTimeHRVAmplitude.update
                # docstring for the full output schema).
                #
                # The API / phone app should emit one update event per item
                # returned here. A suggested WebSocket/push event payload:
                #   {
                #     "event":         "amplitude_update",
                #     "time_s":        trough_t,
                #     "hr_bpm":        latest_hr,
                #     "amplitude_bpm": amp,     // smoothed RSA amplitude
                #     "breathing_bpm": bpm,     // breathing rate
                #     "feedback":      "green" | "yellow" | "red"
                #   }
                try:
                    results = tracker.update(hr_times, hr_values)

                    for item in results:
                        peak_t = hr_times[item['peak_idx']]
                        trough_t = hr_times[item['trough_idx']]
                        amp = item['amplitude']           # smoothed RSA amplitude (BPM)
                        bpm = item['breathing_rate_bpm']  # estimated breathing rate

                        prev_amp = amp_values[-1] if amp_values else None
                        amp_times.append(trough_t)
                        amp_values.append(amp)
                        bpm_values.append(bpm)
                        need_plot_update = True

                        # Collect marker coordinates for the HR chart.
                        breath_peak_times.append(peak_t)
                        breath_peak_hrs.append(item['peak_hr'])
                        breath_trough_times.append(trough_t)
                        breath_trough_hrs.append(item['trough_hr'])
                        pending_amp_annotations.append(
                            (peak_t, trough_t,
                             item['peak_hr'], item['trough_hr'], amp))

                        # Determine feedback colour based on amplitude trend.
                        # Phone app: map this to a UI colour (green / yellow / red).
                        if prev_amp is None or amp >= prev_amp:
                            _color = _ANSI_GREEN
                        elif amp >= prev_amp * AMP_YELLOW_THRESHOLD:
                            _color = _ANSI_YELLOW
                        else:
                            _color = _ANSI_RED

                        latest_hr = hr_values[-1] if hr_values else 0
                        print(f"\n  >> HR: {latest_hr:.0f} bpm | "
                              f"Amplitude: {_color}{amp:.1f}{_ANSI_RESET} BPM | "
                              f"Breathing Rate: {bpm:.1f} breaths/min | "
                              f"Time: {trough_t:.1f}s")

                except Exception as e:
                    print(f"\n[Processing error] {e}")

            # ── Update plot when we have new data ──
            if need_plot_update:
                need_plot_update = False
                line_hr.set_data(hr_times, hr_values)
                line_amp.set_data(amp_times, amp_values)
                line_bpm.set_data(amp_times, bpm_values)

                # Update peak/trough markers on HR graph
                peak_markers.set_data(breath_peak_times, breath_peak_hrs)
                trough_markers.set_data(breath_trough_times, breath_trough_hrs)

                # Draw amplitude annotations (peak→trough spans)
                for pt, tt, phr, thr, a in pending_amp_annotations:
                    mid_t = (pt + tt) / 2
                    mid_hr = (phr + thr) / 2
                    ax_hr.annotate('', xy=(tt, thr), xytext=(pt, phr),
                                   arrowprops=dict(arrowstyle='<->',
                                                   color='purple', lw=1.5))
                    ax_hr.text(mid_t, mid_hr, f'{a:.1f}',
                               ha='center', va='bottom', fontsize=7,
                               color='purple', fontweight='bold')
                pending_amp_annotations.clear()

                for ax in (ax_hr, ax_amp, ax_bpm):
                    ax.relim()
                    ax.autoscale_view()

                for bt in bad_segment_times:
                    for ax in (ax_hr, ax_amp, ax_bpm):
                        ax.axvline(bt, color='gray', alpha=0.3,
                                   linestyle='--', linewidth=0.8)
                bad_segment_times.clear()

                fig.canvas.draw_idle()
                fig.canvas.flush_events()
                plt.pause(0.001)

            # ── Check termination ──
            if data_time >= duration:
                print("\n\nRecording complete!")
                break

            if not ble_thread.is_alive():
                print("\n\nBLE connection lost!")
                break

        stop_event.set()
        ble_thread.join(timeout=5)

        # ── Final summary ──
        print(f"\n{'=' * 60}")
        print("SESSION SUMMARY")
        print(f"{'=' * 60}")
        print(f"Total samples: {len(all_ppg_data)}")
        print(f"Amplitude events: {len(amp_values)}")
        if hr_values:
            print(f"Mean heart rate: {np.mean(hr_values):.1f} bpm")
            print(f"Min heart rate:  {np.min(hr_values):.1f} bpm")
            print(f"Max heart rate:  {np.max(hr_values):.1f} bpm")
        if amp_values:
            print(f"Mean amplitude: {np.mean(amp_values):.2f} BPM")
            print(f"Min amplitude:  {np.min(amp_values):.2f} BPM")
            print(f"Max amplitude:  {np.max(amp_values):.2f} BPM")
        if bpm_values:
            print(f"Mean breathing rate: {np.mean(bpm_values):.1f} breaths/min")
        print(f"{'=' * 60}")

        # Keep plot open
        plt.ioff()
        plt.show()

        # ── Post-session PPG + peaks viewer ──
        # Deduplicate near-duplicate peaks caused by sliding buffer re-detection
        ppg_arr = np.array(all_ppg_data, dtype=float)
        deduped_peaks = clean_peaks(ppg_arr, sorted(all_detected_peaks))
        show_ppg_peaks_viewer(ppg_arr, deduped_peaks, SAMPLING_RATE)

    except KeyboardInterrupt:
        print("\n\nStopped by user")
        stop_event.set()
        ble_thread.join(timeout=5)

    except Exception as e:
        print(f"\nUnexpected error: {e}")
        stop_event.set()
        ble_thread.join(timeout=5)

    # Persist raw PPG data for offline analysis / replay.
    # Phone app: save to local storage or upload to server as a
    # newline-delimited integer file (one ADC sample per line).
    with open("ppg_data.txt", "w") as f:
        for v in all_ppg_data:
            f.write(f"{v}\n")


def show_ppg_peaks_viewer(y, peaks, fs):
    """
    Post-session scrollable viewer for the full raw PPG signal.

    Displays the complete PPG waveform recorded during the session with
    detected cardiac peaks overlaid as red dots. Provides two sliders
    (start time, window size) and an auto-scale toggle.

    This is a desktop-only diagnostic tool. The phone app equivalent is
    a zoomable/scrollable waveform view screen that the user can access
    from the session summary, showing the same raw PPG data with peak
    markers. The screen should support:
        • Pan/swipe to scroll through time.
        • Pinch-to-zoom to change the visible window duration.
        • Toggle peak marker overlay.

    Args:
        y     (np.ndarray): full raw PPG signal, integer ADC values.
        peaks (np.ndarray): global sample indices of detected cardiac peaks
                            (after deduplication across buffer windows).
        fs    (int): sampling rate in Hz (100).
    """
    peaks = np.array(peaks, dtype=int)
    n = len(y)
    if n == 0:
        print("No PPG data to display.")
        return

    t = np.arange(n) / fs
    win_sec = 5.0

    fig, ax = plt.subplots(figsize=(12, 5))
    plt.subplots_adjust(bottom=0.30)

    win_samples = int(win_sec * fs)
    end = min(win_samples, n)
    line, = ax.plot(t[:end], y[:end], lw=1, color='blue')
    peak_scatter, = ax.plot([], [], 'ro', markersize=5)

    ax.set_title('PPG Signal with Detected Peaks (Post-Session)')
    ax.set_xlabel('Time (s)')
    ax.set_ylabel('PPG')
    ax.grid(True)

    auto_scale = [True]

    ax_start = plt.axes([0.12, 0.17, 0.78, 0.03])
    ax_win = plt.axes([0.12, 0.12, 0.78, 0.03])

    max_start = max(0, n - 1) / fs
    s_start = Slider(ax_start, 'Start (s)', 0.0, max_start,
                     valinit=0.0, valstep=1 / fs)
    s_win = Slider(ax_win, 'Window (s)', 1.0, max(5.0, n / fs),
                   valinit=win_sec, valstep=0.5)

    ax_btn_reset = plt.axes([0.12, 0.05, 0.15, 0.05])
    btn_reset = Button(ax_btn_reset, 'Reset 5s')

    ax_btn_auto = plt.axes([0.30, 0.05, 0.20, 0.05])
    btn_auto = Button(ax_btn_auto, 'Auto Scale: ON')

    def update(_=None):
        start_idx = int(s_start.val * fs)
        win_samp = int(s_win.val * fs)
        end_idx = min(start_idx + win_samp, n)
        if end_idx - start_idx < 2:
            return

        x = t[start_idx:end_idx]
        yseg = y[start_idx:end_idx]
        line.set_data(x, yseg)
        ax.set_xlim(x[0], x[-1])

        in_window = peaks[(peaks >= start_idx) & (peaks < end_idx)]
        peak_scatter.set_data(in_window / fs,
                              y[in_window] if len(in_window) else [])

        if auto_scale[0]:
            pad = 0.05 * np.ptp(yseg) if np.ptp(yseg) > 0 else 1.0
            ax.set_ylim(np.min(yseg) - pad, np.max(yseg) + pad)

        fig.canvas.draw_idle()

    def reset(_):
        s_win.set_val(5.0)

    def toggle_auto(_):
        auto_scale[0] = not auto_scale[0]
        btn_auto.label.set_text(
            'Auto Scale: ON' if auto_scale[0] else 'Auto Scale: OFF')
        update()

    s_start.on_changed(update)
    s_win.on_changed(update)
    btn_reset.on_clicked(reset)
    btn_auto.on_clicked(toggle_auto)

    update()
    plt.show()


# ─────────────────────────────────────────────────────────────
# Entry Point (CLI)
#
# Orchestrates the full session flow:
#   1. Enable ANSI colour codes in the Windows console.
#   2. Open hramp_results.txt and mirror all stdout/stderr to it.
#   3. Scan for BLE devices; prompt user to select one.
#   4. Prompt for session duration.
#   5. Confirm and run collect_and_analyze_amplitude().
#
# Phone app equivalent: the session flow is driven by the UI:
#   Device scan screen → Session config screen → Live dashboard
#   → Session summary screen → (optional) PPG viewer screen.
# ─────────────────────────────────────────────────────────────

def main():
    os.system('')  # enable ANSI colour escape codes in the Windows terminal
    results_path = os.path.join(os.path.dirname(__file__), "hramp_results.txt")

    with open(results_path, "w", encoding="utf-8") as results_file:
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        sys.stdout = TeeStdout(sys.stdout, results_file)
        sys.stderr = TeeStdout(sys.stderr, results_file)
        try:
            device_address, duration = get_user_input()
            if device_address is None:
                print("\nExiting...")
                return

            print(f"\n{'=' * 60}")
            print("CONFIGURATION")
            print(f"{'=' * 60}")
            print(f"BLE Device: {device_address}")
            print(f"Duration: {duration} seconds ({duration / 60:.1f} minutes)")
            print(f"{'=' * 60}")

            confirm = input("\nStart recording? (y/n): ").strip().lower()
            if confirm != 'y':
                print("Cancelled.")
                return

            collect_and_analyze_amplitude(device_address, duration)
            print("\nSession complete. Thank you!")
        finally:
            sys.stdout = original_stdout
            sys.stderr = original_stderr


if __name__ == "__main__":
    main()
