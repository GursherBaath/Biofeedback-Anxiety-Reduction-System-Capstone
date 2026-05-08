"""
HRV Analysis API

A FastAPI-based REST API for calculating Heart Rate Variability (HRV) RMSSD
from PPG (photoplethysmography) signal data with signal quality assessment,
and real-time HR amplitude (RSA) biofeedback via session-based endpoints.
"""

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import Dict, List, Optional
from collections import deque
import uuid
import numpy as np
import neurokit2 as nk
from scipy.signal import find_peaks
import os
import warnings

# Suppress warnings from neurokit2
warnings.filterwarnings("ignore")

app = FastAPI(
    title="HRV Analysis API",
    description="Calculate HRV RMSSD from PPG signal data with quality checks",
    version="1.0.0"
)

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

def _get_allowed_origins() -> List[str]:
    raw = os.getenv("HRV_ALLOWED_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


allowed_origins = _get_allowed_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HRVRequest(BaseModel):
    """Request model for HRV analysis"""

    ppg_data: List[float] = Field(
        ...,
        description="Array of PPG signal values",
        min_length=1000,
        example=[438, 445, 452, 460, 468]
    )
    sampling_rate: float = Field(
        ...,
        description="Sampling rate in Hz",
        gt=0,
        le=1000,
        example=100
    )
    max_bad_segments: int = Field(
        default=0,
        description="Maximum number of bad 3-second segments allowed (default: 0)",
        ge=0,
        example=0
    )

    @field_validator("ppg_data")
    @classmethod
    def validate_ppg_data(cls, v):
        """Validate PPG data array"""
        if not v:
            raise ValueError("ppg_data cannot be empty")
        if any(not isinstance(x, (int, float)) for x in v):
            raise ValueError("ppg_data must contain only numeric values")
        return v


class HRVResponse(BaseModel):
    """Response model for successful HRV calculation"""

    success: bool = Field(True, description="Indicates successful calculation")
    rmssd: float = Field(..., description="Calculated RMSSD value in milliseconds")
    bad_segments: int = Field(..., description="Number of bad 3-second segments detected")


class HRVErrorResponse(BaseModel):
    """Response model for failed HRV calculation"""

    success: bool = Field(False, description="Indicates calculation failure")
    error: str = Field(..., description="Error message describing what went wrong")
    bad_segments: int = Field(..., description="Number of bad 3-second segments detected")


def is_segment_bad(segment: np.ndarray, sampling_rate: float) -> bool:
    """
    Quick Signal Quality Index (SQI) checks to detect bad 3-second segments.

    Args:
        segment: Numpy array of PPG values for a 3-second segment
        sampling_rate: Sampling rate in Hz

    Returns:
        True if the segment is likely corrupted, False otherwise
    """
    if len(segment) == 0:
        return True

    seg = np.asarray(segment, dtype=float)

    # 1. Flatline / low variance check
    if np.std(seg) < 1.0:
        return True

    # 2. Clipping / saturation check (too many identical values)
    unique_ratio = len(np.unique(seg)) / len(seg)
    if unique_ratio < 0.02:
        return True

    # 3. Extreme jump check
    if np.max(np.abs(np.diff(seg))) > 2000:
        return True

    # 4. Peak plausibility check (very rough)
    try:
        peaks, _ = nk.ppg_peaks(seg, sampling_rate=sampling_rate)
        if "PPG_Peaks" in peaks:
            peak_count = int(np.sum(peaks["PPG_Peaks"]))
        else:
            peak_count = 0

        # For 3s segment, expect roughly 2-6 peaks at 40-120 bpm
        if peak_count < 2 or peak_count > 6:
            return True
    except Exception:
        return True

    return False


def analyze_window_quality(
    ppg_window: np.ndarray,
    sampling_rate: float,
    segment_sec: int = 3,
    max_bad_segments: int = 0
) -> tuple:
    """
    Split window into 3-second segments and check signal quality.

    Args:
        ppg_window: Array of PPG signal values
        sampling_rate: Sampling rate in Hz
        segment_sec: Length of each segment in seconds (default: 3)
        max_bad_segments: Maximum number of bad segments allowed (default: 0)

    Returns:
        Tuple of (is_bad, bad_segments_count)
    """
    seg_len = int(segment_sec * sampling_rate)
    if seg_len <= 0:
        return True, 0

    bad_segments = 0
    total_segments = len(ppg_window) // seg_len

    for i in range(total_segments):
        start = i * seg_len
        end = start + seg_len
        segment = ppg_window[start:end]
        if is_segment_bad(segment, sampling_rate):
            bad_segments += 1
            if bad_segments > max_bad_segments:
                return True, bad_segments

    return False, bad_segments

def calculate_hrv_rmssd(ppg_window, sampling_rate=100):
    """
    Calculate HRV using RMSSD (Root Mean Square of Successive Differences) from PPG signal.

    Args:
        ppg_window: Array of PPG signal values
        sampling_rate: Sampling rate in Hz

    Returns:
        RMSSD value in milliseconds, or None if calculation fails
    """
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

        return float(rmssd)
    except Exception as e:
        return None


@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "HRV Analysis API",
        "version": "1.0.0",
        "endpoints": {
            "/analyze": "POST - Analyze PPG data and calculate HRV RMSSD",
            "/amplitude/start": "POST - Start an amplitude monitoring session",
            "/amplitude/data": "POST - Send PPG samples and receive amplitude events",
            "/amplitude/stop": "POST - Stop session and get summary",
            "/docs": "GET - Interactive API documentation",
            "/health": "GET - Health check endpoint"
        }
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}


@app.post(
    "/analyze",
    response_model=HRVResponse,
    responses={
        200: {"model": HRVResponse, "description": "Successful HRV calculation"},
        422: {"model": HRVErrorResponse, "description": "Signal quality too poor or calculation failed"}
    },
)
async def analyze_hrv(request: HRVRequest):
    """
    Analyze PPG data and calculate HRV RMSSD with signal quality assessment.

    This endpoint accepts PPG signal data and calculates the RMSSD (Root Mean Square
    of Successive Differences) metric for Heart Rate Variability analysis. It performs
    signal quality checks by dividing the data into 3-second segments and rejecting
    windows with too many bad segments.

    Args:
        request: HRVRequest containing ppg_data, sampling_rate, and max_bad_segments

    Returns:
        HRVResponse with rmssd value and bad_segments count on success

    Raises:
        HTTPException (422): If signal quality is too poor or HRV calculation fails
    """
    ppg_array = np.array(request.ppg_data)

    # Minimum data length check (at least 10 seconds)
    min_samples = int(request.sampling_rate * 10)
    if len(ppg_array) < min_samples:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "success": False,
                "error": (
                    f"Insufficient data: need at least {min_samples} samples "
                    f"({10} seconds), got {len(ppg_array)}"
                ),
                "bad_segments": 0,
            },
        )

    is_bad, bad_segments = analyze_window_quality(
        ppg_array,
        request.sampling_rate,
        segment_sec=3,
        max_bad_segments=request.max_bad_segments,
    )

    if is_bad:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "success": False,
                "error": (
                    "Poor signal quality: "
                    f"{bad_segments} bad segments detected "
                    f"(max allowed: {request.max_bad_segments})"
                ),
                "bad_segments": bad_segments,
            },
        )

    rmssd = calculate_hrv_rmssd(ppg_array, request.sampling_rate)

    if rmssd is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "success": False,
                "error": "HRV calculation failed: unable to process PPG signal",
                "bad_segments": bad_segments,
            },
        )

    return HRVResponse(
        success=True,
        rmssd=rmssd,
        bad_segments=bad_segments,
    )


# ─────────────────────────────────────────────────────────────
# HR Amplitude (RSA) — Session-based real-time biofeedback
# ─────────────────────────────────────────────────────────────

# Constants (same as hr_amplitude.py)
AMP_SAMPLING_RATE = 100
AMP_BUFFER_SEC = 10
AMP_BUFFER_SAMPLES = AMP_BUFFER_SEC * AMP_SAMPLING_RATE  # 1000
AMP_SEGMENT_SEC = 3
AMP_SEGMENT_SAMPLES = AMP_SEGMENT_SEC * AMP_SAMPLING_RATE  # 300
AMP_PROCESS_INTERVAL = 100  # process every 100 samples (~1 s)
AMP_BAD_RESET_DELAY = 4.0
AMP_YELLOW_THRESHOLD = 0.90


def initial_cleaning(ppg_window, peak_indices, rising_window=5):
    cleaned = []
    for idx in peak_indices:
        end_idx = min(idx + rising_window + 1, len(ppg_window))
        after = ppg_window[idx:end_idx]
        if len(after) > 1 and all(after[i] < after[i + 1] for i in range(len(after) - 1)):
            continue
        cleaned.append(idx)
    return cleaned


def clean_peaks(ppg_window, peak_indices, rising_window=5, min_distance=20):
    cleaned = initial_cleaning(ppg_window, peak_indices, rising_window)
    i = 0
    while i < len(cleaned) - 1:
        if cleaned[i + 1] - cleaned[i] < min_distance:
            if ppg_window[cleaned[i]] >= ppg_window[cleaned[i + 1]]:
                cleaned.pop(i + 1)
            else:
                cleaned.pop(i)
        else:
            i += 1
    return cleaned


class RealTimeHRVAmplitude:
    def __init__(self):
        self.last_peak_idx = None
        self.last_peak_hr = None
        self.amplitudes: List[float] = []
        self.last_confirmed_idx = -1
        self.paused = False

    def reset_peak_state(self, hr_len=0):
        self.last_peak_idx = None
        self.last_peak_hr = None
        self.last_confirmed_idx = hr_len - 1

    def update(self, hr_times, hr_values):
        n = len(hr_values)
        if n < 10:
            return []

        hr = np.array(hr_values, dtype=float)
        CONFIRM_MARGIN = 3

        peaks, _ = find_peaks(hr, distance=4, prominence=1.5)
        troughs, _ = find_peaks(-hr, distance=4, prominence=1.5)

        events = sorted(
            [(i, "peak") for i in peaks] + [(i, "trough") for i in troughs]
        )

        feedback = []
        for idx, event_type in events:
            if idx <= self.last_confirmed_idx:
                continue
            if idx >= n - CONFIRM_MARGIN:
                continue

            if event_type == "peak":
                self.last_peak_idx = idx
                self.last_peak_hr = hr[idx]
                self.last_confirmed_idx = idx

            elif event_type == "trough":
                self.last_confirmed_idx = idx
                if self.last_peak_hr is not None and self.last_peak_idx is not None:
                    amplitude = self.last_peak_hr - hr[idx]
                    if amplitude > 1.0:
                        self.amplitudes.append(amplitude)

                        peak_t = hr_times[self.last_peak_idx]
                        trough_t = hr_times[idx]
                        half_period = trough_t - peak_t
                        breathing_rate = 60.0 / (2 * half_period) if half_period > 0 else 0

                        feedback.append({
                            "peak_idx": self.last_peak_idx,
                            "trough_idx": idx,
                            "peak_hr": float(self.last_peak_hr),
                            "trough_hr": float(hr[idx]),
                            "amplitude": float(amplitude),
                            "breathing_rate_bpm": breathing_rate,
                        })
                    self.last_peak_hr = None
                    self.last_peak_idx = None

        return feedback


class AmplitudeSession:
    """Server-side state for one amplitude monitoring session."""

    def __init__(self):
        self.ppg_buffer: deque = deque(maxlen=AMP_BUFFER_SAMPLES)
        self.segment_buffer: deque = deque(maxlen=AMP_SEGMENT_SAMPLES)
        self.tracker = RealTimeHRVAmplitude()
        self.hr_times: List[float] = []
        self.hr_values: List[float] = []
        self.amp_times: List[float] = []
        self.amp_values: List[float] = []
        self.bpm_values: List[float] = []
        self.sample_count = 0
        self.last_process_count = 0
        self.last_hr_sent_count = 0
        self.is_paused = False
        self.bad_start_time: Optional[float] = None
        self.peak_state_reset = False


# In-memory session store
_sessions: Dict[str, AmplitudeSession] = {}


class AmplitudeStartResponse(BaseModel):
    session_id: str


class AmplitudeDataRequest(BaseModel):
    session_id: str
    samples: List[float] = Field(..., min_length=1)


class HRDataPoint(BaseModel):
    time_s: float
    hr_bpm: float


class AmplitudeEvent(BaseModel):
    peak_hr: float
    trough_hr: float
    amplitude: float
    breathing_rate_bpm: float
    feedback_color: str
    time_s: float
    peak_time_s: float


class AmplitudeDataResponse(BaseModel):
    hr: Optional[float] = None
    signal_quality: str
    events: List[AmplitudeEvent] = []
    hr_data: List[HRDataPoint] = []
    sample_count: int


class AmplitudeStopRequest(BaseModel):
    session_id: str


class AmplitudeStopResponse(BaseModel):
    total_samples: int
    total_amplitude_events: int
    mean_hr: Optional[float] = None
    min_hr: Optional[float] = None
    max_hr: Optional[float] = None
    mean_amplitude: Optional[float] = None
    min_amplitude: Optional[float] = None
    max_amplitude: Optional[float] = None
    mean_breathing_rate: Optional[float] = None


@app.post("/amplitude/start", response_model=AmplitudeStartResponse)
async def amplitude_start():
    session_id = uuid.uuid4().hex[:16]
    _sessions[session_id] = AmplitudeSession()
    return AmplitudeStartResponse(session_id=session_id)


@app.post("/amplitude/data", response_model=AmplitudeDataResponse)
async def amplitude_data(request: AmplitudeDataRequest):
    session = _sessions.get(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    new_events: List[AmplitudeEvent] = []
    hr_before = len(session.hr_values)

    for val in request.samples:
        session.ppg_buffer.append(val)
        session.segment_buffer.append(val)
        session.sample_count += 1

        # SQI check on every sample once segment buffer is full
        if len(session.segment_buffer) == AMP_SEGMENT_SAMPLES:
            seg = np.array(session.segment_buffer)
            t = session.sample_count / AMP_SAMPLING_RATE

            if is_segment_bad(seg, AMP_SAMPLING_RATE):
                if not session.is_paused:
                    session.is_paused = True
                    session.tracker.paused = True
                    session.bad_start_time = t
                    session.peak_state_reset = False
                elif (
                    not session.peak_state_reset
                    and session.bad_start_time is not None
                    and (t - session.bad_start_time) >= AMP_BAD_RESET_DELAY
                ):
                    session.tracker.reset_peak_state(len(session.hr_values))
                    session.peak_state_reset = True
            else:
                if session.is_paused:
                    session.is_paused = False
                    session.tracker.paused = False
                    session.bad_start_time = None
                    session.peak_state_reset = False

    # Process every PROCESS_INTERVAL samples when not paused
    while (
        session.sample_count - session.last_process_count >= AMP_PROCESS_INTERVAL
        and len(session.ppg_buffer) >= AMP_SAMPLING_RATE * 5
        and not session.is_paused
    ):
        session.last_process_count += AMP_PROCESS_INTERVAL
        buf_array = np.array(session.ppg_buffer)

        try:
            signals, _ = nk.ppg_process(buf_array, sampling_rate=AMP_SAMPLING_RATE)
            if "PPG_Peaks" in signals:
                raw_peaks = list(np.where(signals["PPG_Peaks"] == 1)[0])
            else:
                raw_peaks = []

            cleaned = clean_peaks(buf_array, raw_peaks)

            if len(cleaned) >= 2:
                ibi = np.diff(cleaned) / AMP_SAMPLING_RATE
                ibi = ibi[(ibi > 0.3) & (ibi < 2.0)]
                if len(ibi) > 0:
                    avg_hr = 60.0 / np.mean(ibi)
                    t_hr = session.sample_count / AMP_SAMPLING_RATE
                    session.hr_times.append(t_hr)
                    session.hr_values.append(avg_hr)
        except Exception:
            pass

        try:
            results = session.tracker.update(session.hr_times, session.hr_values)
            for item in results:
                trough_t = session.hr_times[item["trough_idx"]]
                amp = item["amplitude"]

                prev_amp = session.amp_values[-1] if session.amp_values else None
                session.amp_times.append(trough_t)
                session.amp_values.append(amp)
                session.bpm_values.append(item["breathing_rate_bpm"])

                if prev_amp is None or amp >= prev_amp:
                    color = "green"
                elif amp >= prev_amp * AMP_YELLOW_THRESHOLD:
                    color = "yellow"
                else:
                    color = "red"

                peak_t = session.hr_times[item["peak_idx"]]
                new_events.append(AmplitudeEvent(
                    peak_hr=item["peak_hr"],
                    trough_hr=item["trough_hr"],
                    amplitude=amp,
                    breathing_rate_bpm=item["breathing_rate_bpm"],
                    feedback_color=color,
                    time_s=trough_t,
                    peak_time_s=peak_t,
                ))
        except Exception:
            pass

    # Collect new HR data points added during this call
    new_hr_data = [
        HRDataPoint(time_s=session.hr_times[i], hr_bpm=session.hr_values[i])
        for i in range(hr_before, len(session.hr_values))
    ]

    return AmplitudeDataResponse(
        hr=session.hr_values[-1] if session.hr_values else None,
        signal_quality="PAUSED (bad signal)" if session.is_paused else "ACTIVE",
        events=new_events,
        hr_data=new_hr_data,
        sample_count=session.sample_count,
    )


@app.post("/amplitude/stop", response_model=AmplitudeStopResponse)
async def amplitude_stop(request: AmplitudeStopRequest):
    session = _sessions.pop(request.session_id, None)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    resp = AmplitudeStopResponse(
        total_samples=session.sample_count,
        total_amplitude_events=len(session.amp_values),
    )

    if session.hr_values:
        resp.mean_hr = float(np.mean(session.hr_values))
        resp.min_hr = float(np.min(session.hr_values))
        resp.max_hr = float(np.max(session.hr_values))

    if session.amp_values:
        resp.mean_amplitude = float(np.mean(session.amp_values))
        resp.min_amplitude = float(np.min(session.amp_values))
        resp.max_amplitude = float(np.max(session.amp_values))

    if session.bpm_values:
        resp.mean_breathing_rate = float(np.mean(session.bpm_values))

    return resp


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
