import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {
  Canvas,
  Path as SkiaPath,
  Skia,
  Line,
  vec,
  Text as SkiaText,
  Circle,
  matchFont,
} from '@shopify/react-native-skia';
import type {AmplitudeEvent, HRDataPoint} from '../services/AmplitudeService';

// ─── Chart data types ─────────────────────────────────────
export interface AmplitudeChartsData {
  /** Accumulated HR time series — {time_s, hr_bpm}[] */
  hrSeries: HRDataPoint[];
  /** All amplitude events received so far */
  events: AmplitudeEvent[];
}

interface Props {
  /** Visible viewport width */
  viewportWidth: number;
  /** Total height for all three charts combined */
  height: number;
  dataRef: React.MutableRefObject<AmplitudeChartsData>;
  /** When true, auto-scroll to the right edge on new data */
  isStreaming?: boolean;
}

const GRID_LINES = 4;
const CHART_GAP = 4;
/** Fixed horizontal scale: pixels per second of data */
const PX_PER_SEC = 8;
/** Minimum canvas width in seconds */
const MIN_DURATION_SEC = 30;
/** HR chart gets this fraction of total height (dominant) */
const HR_FRACTION = 0.50;
const SECONDARY_FRACTION = (1 - HR_FRACTION) / 2;

const AmplitudeCharts: React.FC<Props> = ({viewportWidth, height, dataRef, isStreaming = false}) => {
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  // Re-render at ~4 fps while streaming only (no new data when session is ended)
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => setTick(t => t + 1), 250);
    return () => clearInterval(interval);
  }, [isStreaming]);

  const pad = {top: 18, bottom: 14, left: 44, right: 12};

  // Chart heights — HR is the hero chart
  const hrH = height * HR_FRACTION;
  const secH = height * SECONDARY_FRACTION;
  const hrPlotH = hrH - pad.top - pad.bottom;
  const secPlotH = secH - pad.top - pad.bottom;

  const fontStyle = {fontFamily: 'monospace', fontSize: 9, fontWeight: '400' as const};
  const font = matchFont(fontStyle);
  const titleFont = matchFont({fontFamily: 'monospace', fontSize: 10, fontWeight: '600' as const});

  // ─── Helper: auto-range ──────────────────────────────────
  const autoRange = useCallback(
    (values: number[], minSpan = 5): [number, number] => {
      if (values.length === 0) {
        return [0, minSpan];
      }
      let lo = Math.min(...values);
      let hi = Math.max(...values);
      if (hi - lo < minSpan) {
        const mid = (lo + hi) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
      }
      const margin = (hi - lo) * 0.08;
      return [lo - margin, hi + margin];
    },
    [],
  );

  // ─── Data ─────────────────────────────────────────────────
  const data = dataRef.current;
  const hrSeries = data.hrSeries;
  const events = data.events;

  // Time range
  let tMin = 0;
  let tMax = MIN_DURATION_SEC;
  if (hrSeries.length > 0) {
    tMin = hrSeries[0].time_s;
    const dataEnd = hrSeries[hrSeries.length - 1].time_s;
    tMax = Math.max(tMin + MIN_DURATION_SEC, dataEnd + 2);
  }
  const durationSec = tMax - tMin;

  // Canvas width grows with data — this makes the chart scrollable
  const canvasW = Math.max(viewportWidth, pad.left + pad.right + durationSec * PX_PER_SEC);
  const plotW = canvasW - pad.left - pad.right;

  // ─── Coordinate mappers ──────────────────────────────────
  const xPx = useCallback(
    (t: number) => pad.left + ((t - tMin) / (tMax - tMin)) * plotW,
    [tMin, tMax, plotW, pad.left],
  );

  const yPx = useCallback(
    (v: number, lo: number, hi: number, offsetY: number, plotHeight: number) =>
      offsetY + pad.top + plotHeight * (1 - (v - lo) / (hi - lo)),
    [pad.top],
  );

  // Auto-scroll to the right edge only while streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current && canvasW > viewportWidth) {
      scrollRef.current.scrollToEnd({animated: false});
    }
  }, [isStreaming, canvasW, viewportWidth]);

  // ─── Build elements for each chart ────────────────────────
  const elements: React.ReactNode[] = [];
  let key = 0;
  const k = () => key++;

  // ─── CHART 1: Heart Rate with peak/trough markers ────────
  const hrVals = hrSeries.map(p => p.hr_bpm);
  const [hrLo, hrHi] = autoRange(hrVals, 10);
  const chart1Y = 0;

  elements.push(
    <SkiaText key={k()} x={pad.left} y={chart1Y + 12} text="Heart Rate (BPM)" font={titleFont} color="#ccccee" />,
  );

  for (let i = 0; i <= GRID_LINES; i++) {
    const v = hrLo + (i / GRID_LINES) * (hrHi - hrLo);
    const py = yPx(v, hrLo, hrHi, chart1Y, hrPlotH);
    elements.push(
      <Line key={k()} p1={vec(pad.left, py)} p2={vec(canvasW - pad.right, py)} color="rgba(255,255,255,0.08)" strokeWidth={1} />,
    );
    elements.push(
      <SkiaText key={k()} x={2} y={py + 3} text={v.toFixed(0)} font={font} color="rgba(255,255,255,0.4)" />,
    );
  }

  // HR line — thicker for hero chart
  if (hrSeries.length >= 2) {
    const path = Skia.Path.Make();
    path.moveTo(xPx(hrSeries[0].time_s), yPx(hrSeries[0].hr_bpm, hrLo, hrHi, chart1Y, hrPlotH));
    for (let i = 1; i < hrSeries.length; i++) {
      path.lineTo(xPx(hrSeries[i].time_s), yPx(hrSeries[i].hr_bpm, hrLo, hrHi, chart1Y, hrPlotH));
    }
    elements.push(
      <SkiaPath key={k()} path={path} color="#00E676" style="stroke" strokeWidth={2} strokeJoin="round" />,
    );
  }

  // HR data point dots
  for (const pt of hrSeries) {
    elements.push(
      <Circle key={k()} cx={xPx(pt.time_s)} cy={yPx(pt.hr_bpm, hrLo, hrHi, chart1Y, hrPlotH)} r={2} color="#00E676" />,
    );
  }

  // Peak ▲ / Trough ▼ markers + amplitude annotations
  for (const ev of events) {
    const peakX = xPx(ev.peak_time_s);
    const peakY = yPx(ev.peak_hr, hrLo, hrHi, chart1Y, hrPlotH);
    const troughX = xPx(ev.time_s);
    const troughY = yPx(ev.trough_hr, hrLo, hrHi, chart1Y, hrPlotH);

    // Red ▲ peak
    const triUp = Skia.Path.Make();
    triUp.moveTo(peakX, peakY - 8);
    triUp.lineTo(peakX - 5, peakY + 2);
    triUp.lineTo(peakX + 5, peakY + 2);
    triUp.close();
    elements.push(<SkiaPath key={k()} path={triUp} color="#FF5252" style="fill" />);

    // Blue ▼ trough
    const triDown = Skia.Path.Make();
    triDown.moveTo(troughX, troughY + 8);
    triDown.lineTo(troughX - 5, troughY - 2);
    triDown.lineTo(troughX + 5, troughY - 2);
    triDown.close();
    elements.push(<SkiaPath key={k()} path={triDown} color="#448AFF" style="fill" />);

    // Purple amplitude connector + label
    const ampLine = Skia.Path.Make();
    ampLine.moveTo(peakX, peakY);
    ampLine.lineTo(troughX, troughY);
    elements.push(
      <SkiaPath key={k()} path={ampLine} color="rgba(186,104,255,0.6)" style="stroke" strokeWidth={1.2} />,
    );
    const midX = (peakX + troughX) / 2;
    const midY = (peakY + troughY) / 2;
    elements.push(
      <SkiaText key={k()} x={midX - 8} y={midY - 5} text={ev.amplitude.toFixed(1)} font={font} color="#BA68FF" />,
    );
  }

  // ─── CHART 2: Amplitude ──────────────────────────────────
  const chart2Y = hrH + CHART_GAP;
  const ampVals = events.map(e => e.amplitude);
  const [ampLo, ampHi] = autoRange(ampVals, 5);

  elements.push(
    <SkiaText key={k()} x={pad.left} y={chart2Y + 12} text="RSA Amplitude (BPM)" font={titleFont} color="#aaaacc" />,
  );

  for (let i = 0; i <= GRID_LINES; i++) {
    const v = ampLo + (i / GRID_LINES) * (ampHi - ampLo);
    const py = yPx(v, ampLo, ampHi, chart2Y, secPlotH);
    elements.push(
      <Line key={k()} p1={vec(pad.left, py)} p2={vec(canvasW - pad.right, py)} color="rgba(255,255,255,0.08)" strokeWidth={1} />,
    );
    elements.push(
      <SkiaText key={k()} x={2} y={py + 3} text={v.toFixed(1)} font={font} color="rgba(255,255,255,0.35)" />,
    );
  }

  if (events.length >= 2) {
    const path = Skia.Path.Make();
    path.moveTo(xPx(events[0].time_s), yPx(events[0].amplitude, ampLo, ampHi, chart2Y, secPlotH));
    for (let i = 1; i < events.length; i++) {
      path.lineTo(xPx(events[i].time_s), yPx(events[i].amplitude, ampLo, ampHi, chart2Y, secPlotH));
    }
    elements.push(
      <SkiaPath key={k()} path={path} color="#448AFF" style="stroke" strokeWidth={1.5} strokeJoin="round" />,
    );
  }

  const FB_COLORS: Record<string, string> = {green: '#00E676', yellow: '#FFD600', red: '#FF5252'};
  for (const ev of events) {
    const cx = xPx(ev.time_s);
    const cy = yPx(ev.amplitude, ampLo, ampHi, chart2Y, secPlotH);
    const dotColor = FB_COLORS[ev.feedback_color] ?? '#448AFF';
    elements.push(
      <Circle key={k()} cx={cx} cy={cy} r={3} color={dotColor} />,
    );
    elements.push(
      <SkiaText key={k()} x={cx - 10} y={cy - 7} text={ev.amplitude.toFixed(1)} font={font} color={dotColor} />,
    );
  }

  // ─── CHART 3: Breathing Rate ─────────────────────────────
  const chart3Y = hrH + secH + CHART_GAP * 2;
  const brVals = events.map(e => e.breathing_rate_bpm);
  const [brLo, brHi] = autoRange(brVals, 4);

  elements.push(
    <SkiaText key={k()} x={pad.left} y={chart3Y + 12} text="Breathing Rate (br/min)" font={titleFont} color="#aaaacc" />,
  );

  for (let i = 0; i <= GRID_LINES; i++) {
    const v = brLo + (i / GRID_LINES) * (brHi - brLo);
    const py = yPx(v, brLo, brHi, chart3Y, secPlotH);
    elements.push(
      <Line key={k()} p1={vec(pad.left, py)} p2={vec(canvasW - pad.right, py)} color="rgba(255,255,255,0.08)" strokeWidth={1} />,
    );
    elements.push(
      <SkiaText key={k()} x={2} y={py + 3} text={v.toFixed(1)} font={font} color="rgba(255,255,255,0.35)" />,
    );
  }

  if (events.length >= 2) {
    const path = Skia.Path.Make();
    path.moveTo(xPx(events[0].time_s), yPx(events[0].breathing_rate_bpm, brLo, brHi, chart3Y, secPlotH));
    for (let i = 1; i < events.length; i++) {
      path.lineTo(xPx(events[i].time_s), yPx(events[i].breathing_rate_bpm, brLo, brHi, chart3Y, secPlotH));
    }
    elements.push(
      <SkiaPath key={k()} path={path} color="#FF5252" style="stroke" strokeWidth={1.5} strokeJoin="round" />,
    );
  }

  for (const ev of events) {
    const cx = xPx(ev.time_s);
    const cy = yPx(ev.breathing_rate_bpm, brLo, brHi, chart3Y, secPlotH);
    const s = 3;
    const cross = Skia.Path.Make();
    cross.moveTo(cx - s, cy - s);
    cross.lineTo(cx + s, cy + s);
    cross.moveTo(cx + s, cy - s);
    cross.lineTo(cx - s, cy + s);
    elements.push(
      <SkiaPath key={k()} path={cross} color="#FF5252" style="stroke" strokeWidth={1.5} />,
    );
    elements.push(
      <SkiaText key={k()} x={cx - 10} y={cy - 7} text={ev.breathing_rate_bpm.toFixed(1)} font={font} color="rgba(255,120,120,0.9)" />,
    );
  }

  return (
    <View style={[styles.container, {height}]}>
      <ScrollView
        ref={scrollRef}
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={{width: viewportWidth, height}}
        contentContainerStyle={{width: canvasW, height}}>
        <Canvas style={{width: canvasW, height}}>{elements}</Canvas>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    overflow: 'hidden',
  },
});

export default React.memo(AmplitudeCharts);
