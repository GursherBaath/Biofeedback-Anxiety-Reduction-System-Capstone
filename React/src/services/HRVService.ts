export interface HRVResult {
  success: boolean;
  rmssd?: number;
  bad_segments: number;
  error?: string;
  timestamp: number;
}

export async function analyzeHRV(
  apiUrl: string,
  ppgData: number[],
  samplingRate: number,
  maxBadSegments: number = 0,
): Promise<HRVResult> {
  const url = `${apiUrl}/analyze`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      ppg_data: ppgData,
      sampling_rate: samplingRate,
      max_bad_segments: maxBadSegments,
    }),
  });

  const timestamp = Date.now();

  if (response.ok) {
    const data = await response.json();
    return {
      success: true,
      rmssd: data.rmssd,
      bad_segments: data.bad_segments,
      timestamp,
    };
  }

  // API returns 422 for quality/calculation failures
  const errorData = await response.json().catch(() => null);
  const detail = errorData?.detail;
  return {
    success: false,
    bad_segments: detail?.bad_segments ?? 0,
    error: detail?.error ?? `HTTP ${response.status}`,
    timestamp,
  };
}
