export interface AmplitudeEvent {
  peak_hr: number;
  trough_hr: number;
  amplitude: number;
  breathing_rate_bpm: number;
  feedback_color: 'green' | 'yellow' | 'red';
  time_s: number;
  peak_time_s: number;
}

export interface HRDataPoint {
  time_s: number;
  hr_bpm: number;
}

export interface AmplitudeDataResult {
  hr: number | null;
  signal_quality: string;
  events: AmplitudeEvent[];
  hr_data: HRDataPoint[];
  sample_count: number;
  timestamp: number;
}

export interface AmplitudeStopResult {
  total_samples: number;
  total_amplitude_events: number;
  mean_hr: number | null;
  min_hr: number | null;
  max_hr: number | null;
  mean_amplitude: number | null;
  min_amplitude: number | null;
  max_amplitude: number | null;
  mean_breathing_rate: number | null;
}

export async function amplitudeStart(
  apiUrl: string,
): Promise<string> {
  const response = await fetch(`${apiUrl}/amplitude/start`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.session_id;
}

export async function amplitudeSendData(
  apiUrl: string,
  sessionId: string,
  samples: number[],
): Promise<AmplitudeDataResult> {
  const response = await fetch(`${apiUrl}/amplitude/data`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: sessionId, samples}),
  });

  const timestamp = Date.now();

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.detail ?? `HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    hr: data.hr,
    signal_quality: data.signal_quality,
    events: data.events ?? [],
    hr_data: data.hr_data ?? [],
    sample_count: data.sample_count,
    timestamp,
  };
}

export async function amplitudeStop(
  apiUrl: string,
  sessionId: string,
): Promise<AmplitudeStopResult> {
  const response = await fetch(`${apiUrl}/amplitude/stop`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: sessionId}),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.detail ?? `HTTP ${response.status}`);
  }
  return await response.json();
}
