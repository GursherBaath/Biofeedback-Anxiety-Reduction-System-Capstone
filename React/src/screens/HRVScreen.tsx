import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  StyleSheet,
  View,
  Text,
  Alert,
  Modal,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  ScrollView,
  Platform,
  ImageBackground,
} from 'react-native';
import {bleService} from '../services/BleService';
import {analyzeHRV, HRVResult} from '../services/HRVService';
import {saveSession, saveDemoSessionRecord} from '../services/SessionStorageService';
import {useAppContext} from '../context/AppContext';
import PPGChart from '../components/PPGChart';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  Canvas,
  Path as SkiaPath,
  Skia,
  Circle,
} from '@shopify/react-native-skia';

// Mirror of program.py check_hrv_status
function checkHRVStatus(current: number, previous: number | null): 0 | 1 | 2 {
  if (previous === null) return 1;
  const change = current - previous;
  if (change >= 0) return 0;      // GREEN: improving
  if (change > -5) return 1;      // YELLOW: slight drop
  return 2;                        // RED: significant drop ≥5ms
}

const HRV_FEEDBACK = [
  {color: '#00E676', bg: 'rgba(0,230,118,0.18)', symbol: '✓', message: 'EXCELLENT — HRV IMPROVING'},
  {color: '#FFD600', bg: 'rgba(255,214,0,0.18)',  symbol: '~', message: 'GOOD — SLIGHT DECREASE'},
  {color: '#FF5252', bg: 'rgba(255,82,82,0.18)',  symbol: '✗', message: 'REFOCUS — SIGNIFICANT DROP'},
] as const;

interface FeedbackInfo {
  status: 0 | 1 | 2;
  currentRmssd: number;
  previousRmssd: number | null;
  windowCount: number;
  baselineRmssd: number | null;
}

interface SessionSummary {
  baselineRmssd: number | null;
  finalRmssd: number | null;
}

type ViewMode = 'ppg' | 'hrv' | 'light';
const VIEW_MODES: ViewMode[] = ['ppg', 'hrv', 'light'];
const VIEW_MODE_ICON: Record<ViewMode, string> = {
  ppg: 'chart-line',
  hrv: 'chart-timeline-variant',
  light: 'traffic-light',
};

interface HRVTrendProps { history: HRVResult[]; width: number; height: number; scrollable?: boolean; fullHistory?: HRVResult[]; }
const MIN_POINT_SPACING = 64;
const HRVTrendChart: React.FC<HRVTrendProps> = ({history, width, height, scrollable, fullHistory}) => {
  const pad = {top: 24, bottom: 12, left: 24, right: 24};
  const successful = scrollable && fullHistory && fullHistory.length > 0
    ? fullHistory.filter(h => h.success && h.rmssd != null)
    : [...history].reverse().filter(h => h.success && h.rmssd != null);
  if (successful.length === 0) {
    return (
      <View style={{width, height, alignItems: 'center', justifyContent: 'center'}}>
        <Text style={{color: 'rgba(180,160,255,0.5)', fontFamily: 'monospace', fontSize: 13}}>
          Collecting HRV data...
        </Text>
      </View>
    );
  }
  const chartWidth = scrollable
    ? Math.max(width, successful.length * MIN_POINT_SPACING + pad.left + pad.right)
    : width;
  const plotW = chartWidth - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = successful.map(h => h.rmssd as number);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, 5);
  const margin = span * 0.2;
  const yMin = lo - margin;
  const yMax = hi + margin;
  const n = successful.length;
  const xStep = n > 1 ? plotW / (n - 1) : plotW;
  const toX = (i: number) => pad.left + i * xStep;
  const toY = (v: number) => pad.top + plotH * (1 - (v - yMin) / (yMax - yMin));
  const path = Skia.Path.Make();
  successful.forEach((h, i) => {
    const x = toX(i);
    const y = toY(h.rmssd as number);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  const chartContent = (
    <View style={{width: chartWidth, height}}>
      <Canvas style={{width: chartWidth, height}}>
        <SkiaPath path={path} style="stroke" strokeWidth={2} color="rgba(180,150,255,0.7)" />
        {successful.map((h, i) => {
          const x = toX(i);
          const y = toY(h.rmssd as number);
          const prev = i > 0 ? (successful[i - 1].rmssd as number) : null;
          const dotColor =
            prev === null ? '#9090ff' : (h.rmssd as number) >= prev ? '#00E676' : '#FF5252';
          return <Circle key={i} cx={x} cy={y} r={6} color={dotColor} />;
        })}
      </Canvas>
      {successful.map((h, i) => {
        const x = toX(i);
        const y = toY(h.rmssd as number);
        return (
          <Text
            key={`lbl-${i}`}
            style={{
              position: 'absolute',
              left: x - 20,
              top: Math.max(2, y - 22),
              width: 40,
              textAlign: 'center',
              color: '#ffffff',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: '600',
            }}>
            {(h.rmssd as number).toFixed(1)}
          </Text>
        );
      })}
    </View>
  );
  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{width}}>
        {chartContent}
      </ScrollView>
    );
  }
  return chartContent;
};

const CHART_WINDOW = 600;
const SAMPLING_RATE = 100;
const ROLLING_WINDOW_SEC = 30;
const ROLLING_WINDOW_SAMPLES = ROLLING_WINDOW_SEC * SAMPLING_RATE; // 3000
const UPDATE_INTERVAL_MS = 10_000; // 10 seconds
const MAX_HISTORY = 10;
const RATE_WINDOW_SEC = 5;

const HRVScreen: React.FC = () => {
  const [status, setStatus] = useState('Ready');
  const [isConnected, setIsConnected] = useState(bleService.connected);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const {apiUrl, exitSession, isDemoMode} = useAppContext();
  const [hrvHistory, setHrvHistory] = useState<HRVResult[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [collectedSeconds, setCollectedSeconds] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackInfo | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('ppg');
  const [badSegmentWarning, setBadSegmentWarning] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [isInfoVisible, setIsInfoVisible] = useState(false);

  const cycleView = useCallback(() => {
    setViewMode(m => {
      const idx = VIEW_MODES.indexOf(m);
      return VIEW_MODES[(idx + 1) % VIEW_MODES.length];
    });
  }, []);

  const showHRVInfo = useCallback(() => setIsInfoVisible(true), []);

  // Refs
  const latestHRVRef = useRef<HRVResult | undefined>(undefined);
  const previousRmssdRef = useRef<number | null>(null);
  const windowCountRef = useRef(0);
  const baselineRmssdRef = useRef<number | null>(null);
  const hadConnectionRef = useRef(bleService.connected);
  const disconnectHandledRef = useRef(false);
  const disconnectedDuringSessionRef = useRef(false);
  const dataRef = useRef<number[]>([]);
  const statsRef = useRef({totalSamples: 0, rate: 0, lastRxAge: 0});

  // Rolling buffer for HRV analysis (last 30 seconds)
  const rollingBufferRef = useRef<number[]>([]);
  const sampleCountRef = useRef(0);
  // When true, a bad segment was detected — block analysis until buffer refills
  const badSegmentCooldownRef = useRef(false);
  const badSegmentSampleCountRef = useRef(0);

  // Rate tracking
  const rateCounterRef = useRef(0);
  const rateWindowStartRef = useRef(Date.now());
  const lastRxTimeRef = useRef(0);

  // Timer refs
  const updateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const collectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const isAnalyzingRef = useRef(false);
  const fullHrvHistoryRef = useRef<HRVResult[]>([]);
  const pendingSaveRef = useRef<{
    id: string; startTime: number; endTime: number; durSeconds: number;
    baselineRmssd: number | null; demoMode: boolean;
  } | null>(null);

  const screenWidth = Dimensions.get('window').width;
  const chartHeight = 220;

  // Rate calculation interval
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - rateWindowStartRef.current) / 1000;
      if (elapsed > 0) {
        statsRef.current.rate = rateCounterRef.current / elapsed;
      }
      if (lastRxTimeRef.current > 0) {
        statsRef.current.lastRxAge = (now - lastRxTimeRef.current) / 1000;
      }
      if (elapsed >= RATE_WINDOW_SEC) {
        rateCounterRef.current = 0;
        rateWindowStartRef.current = now;
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Handle incoming PPG data
  const handleData = useCallback((samples: number[]) => {
    if (!isRecordingRef.current) return;
    // Update chart buffer
    const data = dataRef.current;
    for (let i = 0; i < samples.length; i++) {
      data.push(samples[i]);
    }
    if (data.length > CHART_WINDOW + 100) {
      dataRef.current = data.slice(-CHART_WINDOW);
    }

    // Update rolling buffer for HRV
    const rolling = rollingBufferRef.current;
    for (let i = 0; i < samples.length; i++) {
      rolling.push(samples[i]);
    }
    if (rolling.length > ROLLING_WINDOW_SAMPLES + 500) {
      rollingBufferRef.current = rolling.slice(-ROLLING_WINDOW_SAMPLES);
    }

    // Count samples accumulated since last bad-segment flush
    if (badSegmentCooldownRef.current) {
      badSegmentSampleCountRef.current += samples.length;
      if (badSegmentSampleCountRef.current >= ROLLING_WINDOW_SAMPLES) {
        badSegmentCooldownRef.current = false;
        badSegmentSampleCountRef.current = 0;
        // Warning will clear on the next successful analysis
      }
    }

    // Update stats
    statsRef.current.totalSamples += samples.length;
    rateCounterRef.current += samples.length;
    lastRxTimeRef.current = Date.now();
    sampleCountRef.current += samples.length;
  }, []);

  // Send data to API for HRV analysis
  const sendToAPI = useCallback(async () => {
    if (!isRecordingRef.current) {
      return;
    }
    // Block analysis while waiting for fresh data after a bad segment
    if (badSegmentCooldownRef.current) {
      return;
    }
    const buffer = rollingBufferRef.current;
    console.log('[HRV] sendToAPI called, buffer length:', buffer.length, '/', ROLLING_WINDOW_SAMPLES);
    if (buffer.length < ROLLING_WINDOW_SAMPLES) {
      return; // Not enough data yet
    }

    const windowData = buffer.slice(-ROLLING_WINDOW_SAMPLES);
    isAnalyzingRef.current = true;
    setIsAnalyzing(true);
    console.log('[HRV] Sending', windowData.length, 'samples to', apiUrl);
    try {
      const result = await analyzeHRV(apiUrl, windowData, SAMPLING_RATE, 1);
      console.log('[HRV] Result:', JSON.stringify(result));
      setHrvHistory(prev => [result, ...prev].slice(0, MAX_HISTORY));
      // Update latest ref for session saving
      if (result.success) {
        latestHRVRef.current = result;
        fullHrvHistoryRef.current = [...fullHrvHistoryRef.current, result];
      }
      // Bad segment detected — flush buffer and wait for 30s of clean data
      if (result.bad_segments > 0) {
        rollingBufferRef.current = [];
        badSegmentCooldownRef.current = true;
        badSegmentSampleCountRef.current = 0;
        setBadSegmentWarning(true);
        return;
      }
      // Compute feedback status (mirrors program.py check_hrv_status)
      if (result.success && result.rmssd != null) {
        setBadSegmentWarning(false);
        windowCountRef.current += 1;

        if (baselineRmssdRef.current === null) {
          baselineRmssdRef.current = result.rmssd;
        }

        const status = checkHRVStatus(result.rmssd, previousRmssdRef.current);
        setFeedback({
          status,
          currentRmssd: result.rmssd,
          previousRmssd: previousRmssdRef.current,
          windowCount: windowCountRef.current,
          baselineRmssd: baselineRmssdRef.current,
        });
        previousRmssdRef.current = result.rmssd;
      }
    } catch (e: any) {
      console.log('[HRV] Error:', e.message);
      const errorResult: HRVResult = {
        success: false,
        bad_segments: 0,
        error: e.message || 'Network error',
        timestamp: Date.now(),
      };
      setHrvHistory(prev => [errorResult, ...prev].slice(0, MAX_HISTORY));
    } finally {
      isAnalyzingRef.current = false;
      setIsAnalyzing(false);
      // Complete a deferred session save if End Session was pressed while this call was in flight
      if (pendingSaveRef.current && !isRecordingRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        const latestRmssd = latestHRVRef.current?.rmssd;
        const baselineRmssd = pending.baselineRmssd;
        const rmssdImprovementPct =
          baselineRmssd != null && latestRmssd != null && baselineRmssd > 0
            ? ((latestRmssd - baselineRmssd) / baselineRmssd) * 100
            : undefined;
        const saveFn = pending.demoMode ? saveDemoSessionRecord : saveSession;
        saveFn({
          id: pending.id,
          type: 'hrv',
          startTime: pending.startTime,
          endTime: pending.endTime,
          durSeconds: pending.durSeconds,
          rmssd: latestRmssd,
          baselineRmssd: baselineRmssd ?? undefined,
          endRmssd: latestRmssd,
          rmssdImprovementPct,
        });
      }
    }
  }, [apiUrl]);

  // Register BLE listener and start HRV update timer
  useEffect(() => {
    bleService.addOnData('hrv', handleData);
    bleService.addOnStatusChange('hrv', (newStatus: string) => {
      const connected = newStatus.includes('Streaming');
      setIsConnected(connected);

      if (connected) {
        hadConnectionRef.current = true;
        disconnectHandledRef.current = false;
        return;
      }

      if (!hadConnectionRef.current || disconnectHandledRef.current) {
        return;
      }

      disconnectHandledRef.current = true;
      disconnectedDuringSessionRef.current = disconnectedDuringSessionRef.current || isRecordingRef.current;
      isRecordingRef.current = false;
      setIsRecording(false);
      setStatus('Connection lost');

      Alert.alert(
        'Device disconnected',
        'Connection lost. Returning to the main screen. This session was not saved.',
        [{text: 'OK', onPress: exitSession}],
        {cancelable: false},
      );
    });

    // Sync initial connection state
    if (bleService.connected) {
      setIsConnected(true);
    }

    return () => {
      bleService.removeOnData('hrv');
      bleService.removeOnStatusChange('hrv');
    };
  }, [handleData]);

  // Update the collected seconds counter and HRV timer only during an active session
  useEffect(() => {
    if (isConnected && isRecording) {
      // Track how many seconds of data we have
      collectTimerRef.current = setInterval(() => {
        const secs = Math.floor(sampleCountRef.current / SAMPLING_RATE);
        setCollectedSeconds(secs);
      }, 1000);

      // Start HRV analysis timer: every 10 seconds, send last 30s to API
      updateTimerRef.current = setInterval(() => {
        sendToAPI();
      }, UPDATE_INTERVAL_MS);
    } else {
      // Clear timers on disconnect
      if (updateTimerRef.current) {
        clearInterval(updateTimerRef.current);
        updateTimerRef.current = null;
      }
      if (collectTimerRef.current) {
        clearInterval(collectTimerRef.current);
        collectTimerRef.current = null;
      }
    }

    return () => {
      if (updateTimerRef.current) {
        clearInterval(updateTimerRef.current);
        updateTimerRef.current = null;
      }
      if (collectTimerRef.current) {
        clearInterval(collectTimerRef.current);
        collectTimerRef.current = null;
      }
    };
  }, [isConnected, isRecording, sendToAPI]);

  const handleRecording = useCallback(() => {
    if (isRecording) {
      if (disconnectedDuringSessionRef.current) {
        disconnectedDuringSessionRef.current = false;
        setStatus('Session canceled');
        return;
      }

      const endTime = Date.now();
      const durSeconds = Math.round((endTime - recordingStartTimeRef.current) / 1000);
      const baselineRmssd = baselineRmssdRef.current;
      isRecordingRef.current = false;

      if (isAnalyzingRef.current) {
        // An API call is in flight — defer the save until it resolves so we capture the final RMSSD
        pendingSaveRef.current = {
          id: recordingStartTimeRef.current.toString(),
          startTime: recordingStartTimeRef.current,
          endTime,
          durSeconds,
          baselineRmssd,
          demoMode: isDemoMode,
        };
        // Show the card now; finalRmssd will be read from feedback once the in-flight call resolves
        setSessionSummary({baselineRmssd, finalRmssd: null});
      } else {
        const latestRmssd = latestHRVRef.current?.rmssd;
        const rmssdImprovementPct =
          baselineRmssd != null && latestRmssd != null && baselineRmssd > 0
            ? ((latestRmssd - baselineRmssd) / baselineRmssd) * 100
            : undefined;
        const save = isDemoMode ? saveDemoSessionRecord : saveSession;
        save({
          id: recordingStartTimeRef.current.toString(),
          type: 'hrv',
          startTime: recordingStartTimeRef.current,
          endTime,
          durSeconds,
          rmssd: latestRmssd,
          baselineRmssd: baselineRmssd ?? undefined,
          endRmssd: latestRmssd,
          rmssdImprovementPct,
        });
        setSessionSummary({baselineRmssd, finalRmssd: latestRmssd ?? null});
      }
      setIsRecording(false);
      setStatus('Session ended');
    } else {
      recordingStartTimeRef.current = Date.now();
      dataRef.current = [];
      rollingBufferRef.current = [];
      sampleCountRef.current = 0;
      statsRef.current = {totalSamples: 0, rate: 0, lastRxAge: 0};
      rateCounterRef.current = 0;
      rateWindowStartRef.current = Date.now();
      // Reset feedback state
      latestHRVRef.current = undefined;
      previousRmssdRef.current = null;
      windowCountRef.current = 0;
      baselineRmssdRef.current = null;
      disconnectedDuringSessionRef.current = false;
      badSegmentCooldownRef.current = false;
      badSegmentSampleCountRef.current = 0;
      pendingSaveRef.current = null;
      fullHrvHistoryRef.current = [];
      setFeedback(null);
      setHrvHistory([]);
      setCollectedSeconds(0);
      setBadSegmentWarning(false);
      setSessionSummary(null);
      isRecordingRef.current = true;
      setIsRecording(true);
      setStatus('Session active');
    }
  }, [isRecording]);

  return (
    <ImageBackground
      source={require('../assets/images/background2.jpg')}
      style={styles.container}
      resizeMode="cover">

      {/* Info Modal */}
      <Modal
        visible={isInfoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsInfoVisible(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setIsInfoVisible(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>HRV Analysis</Text>
            <Text style={styles.modalBody}>
              {'HRV (Heart Rate Variability) measures how well your nervous system is recovering and adapting.\n\nTo get the most from your session:\n\n- Breathe slowly and deeply\n- Aim for ~5–6 breaths per minute\n- Relax your body and clear your mind\n\nWatch the traffic light:\n🟢 Green — HRV is improving, keep it up\n🟡 Yellow — slight dip, refocus\n🔴 Red — significant drop, adjust your breathing\n\nThe longer you hold green, the better.'}
            </Text>
            <TouchableOpacity
              style={styles.modalBtn}
              onPress={() => setIsInfoVisible(false)}
              activeOpacity={0.7}>
              <Text style={styles.modalBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
      <View style={styles.bgOverlay} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <ScrollView style={styles.scrollContent} contentContainerStyle={styles.scrollContainer}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <TouchableOpacity onPress={exitSession} style={styles.backBtn} activeOpacity={0.7}>
              <Icon name="arrow-left" size={26} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.title}>HRV Analysis</Text>
            <TouchableOpacity onPress={showHRVInfo} style={styles.infoBtn} activeOpacity={0.7}>
              <Icon name="information-outline" size={22} color="rgba(200, 180, 255, 0.85)" />
            </TouchableOpacity>
            <View style={{flex: 1}} />
            <TouchableOpacity onPress={cycleView} style={styles.cycleModeBtn} activeOpacity={0.7}>
              <Icon name={VIEW_MODE_ICON[viewMode]} size={22} color="rgba(200,180,255,0.85)" />
            </TouchableOpacity>
          </View>
          {status !== 'Ready' && (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  {backgroundColor: isConnected ? '#00E676' : '#FF5252'},
                ]}
              />
              <Text style={styles.statusText}>{status}</Text>
            </View>
          )}
        </View>

        {/* Chart — mode-dependent */}
        {viewMode !== 'light' && (
          <View style={styles.chartContainer}>
            {viewMode === 'ppg' ? (
              <PPGChart
                width={screenWidth - 16}
                height={chartHeight}
                dataRef={dataRef}
                statsRef={statsRef}
                minimal
              />
            ) : (
              <HRVTrendChart
                history={hrvHistory}
                width={screenWidth - 16}
                height={chartHeight}
                scrollable={!isRecording}
                fullHistory={fullHrvHistoryRef.current}
              />
            )}
          </View>
        )}

        {/* Bad-segment warning badge */}
        {badSegmentWarning && (
          <View style={styles.badSegmentBadge}>
            <Icon name="alert" size={14} color="#FFD600" style={{marginRight: 6}} />
            <Text style={styles.badSegmentText}>Signal quality issue — recollecting 30s</Text>
          </View>
        )}

        {/* Initial collection banner */}
        {isRecording && feedback === null && !badSegmentWarning && (
          <View style={styles.collectingBanner}>
            <Icon name="timer-sand" size={16} color="rgba(200,180,255,0.8)" style={{marginRight: 8}} />
            <View style={{flex: 1}}>
              <Text style={styles.collectingText}>
                Collecting initial data… {Math.min(collectedSeconds, ROLLING_WINDOW_SEC)}/{ROLLING_WINDOW_SEC}s
              </Text>
              <View style={styles.collectingTrack}>
                <View
                  style={[
                    styles.collectingFill,
                    {width: `${Math.min((collectedSeconds / ROLLING_WINDOW_SEC) * 100, 100)}%`},
                  ]}
                />
              </View>
              <Text style={styles.collectingHint}>Breathe slowly and relax — first result in ~{Math.max(0, ROLLING_WINDOW_SEC - collectedSeconds)}s</Text>
            </View>
          </View>
        )}

        {/* Session summary — shown prominently when session ends */}
        {!isRecording && sessionSummary && (() => {
          const lastEntry = [...fullHrvHistoryRef.current].reverse().find(h => h.success && h.rmssd != null);
          const finalRmssd = lastEntry?.rmssd ?? null;
          const baseline = sessionSummary.baselineRmssd;
          const pct =
            baseline != null && baseline > 0 && finalRmssd != null
              ? ((finalRmssd - baseline) / baseline) * 100
              : null;
          const improved = pct != null && pct >= 0;
          return (
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>SESSION COMPLETE</Text>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>BASELINE RMSSD</Text>
                <Text style={styles.summaryBaselineValue}>
                  {baseline != null ? `${baseline.toFixed(1)} ms` : '—'}
                </Text>
              </View>
              {finalRmssd != null && (
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>FINAL RMSSD</Text>
                  <Text style={[
                    styles.summaryValue,
                    {color: baseline != null && finalRmssd >= baseline ? '#00E676' : '#FF5252'},
                  ]}>
                    {finalRmssd.toFixed(1)} ms
                  </Text>
                </View>
              )}
              {pct != null && (
                <View style={[styles.summaryRow, {marginTop: 8}]}>
                  <Text style={styles.summaryLabel}>IMPROVEMENT</Text>
                  <Text style={[styles.summaryValue, {color: improved ? '#00E676' : '#FF5252', fontSize: 20}]}>
                    {improved ? '+' : ''}{pct.toFixed(1)}%
                  </Text>
                </View>
              )}
            </View>
          );
        })()}

        {/* Traffic Light — full-page, no box */}
        <View style={[styles.trafficLightWrapper, viewMode === 'light' && styles.trafficLightWrapperLarge]}>
          {feedback !== null ? (
            <View style={[styles.trafficLight, viewMode === 'light' && styles.trafficLightLarge]}>
              <View style={[
                styles.trafficBulb,
                viewMode === 'light' && styles.trafficBulbLarge,
                {backgroundColor: '#FF5252'},
                feedback.status === 2
                  ? {shadowColor: '#FF5252', shadowOpacity: 1, shadowRadius: 24, elevation: 14}
                  : {opacity: 0.12},
              ]} />
              <View style={[
                styles.trafficBulb,
                viewMode === 'light' && styles.trafficBulbLarge,
                {backgroundColor: '#FFD600'},
                feedback.status === 1
                  ? {shadowColor: '#FFD600', shadowOpacity: 1, shadowRadius: 24, elevation: 14}
                  : {opacity: 0.12},
              ]} />
              <View style={[
                styles.trafficBulb,
                viewMode === 'light' && styles.trafficBulbLarge,
                {backgroundColor: '#00E676'},
                feedback.status === 0
                  ? {shadowColor: '#00E676', shadowOpacity: 1, shadowRadius: 24, elevation: 14}
                  : {opacity: 0.12},
              ]} />
            </View>
          ) : (
            <View style={[styles.trafficLight, viewMode === 'light' && styles.trafficLightLarge]}>
              <View style={[styles.trafficBulb, viewMode === 'light' && styles.trafficBulbLarge, {backgroundColor: '#FF5252', opacity: 0.12}]} />
              <View style={[styles.trafficBulb, viewMode === 'light' && styles.trafficBulbLarge, {backgroundColor: '#FFD600', opacity: 0.12}]} />
              <View style={[styles.trafficBulb, viewMode === 'light' && styles.trafficBulbLarge, {backgroundColor: '#00E676', opacity: 0.12}]} />
            </View>
          )}
        </View>

        {/* Improvement % — centered above button */}
        {feedback !== null && feedback.baselineRmssd != null && feedback.baselineRmssd > 0 && (() => {
          const pct = ((feedback.currentRmssd - feedback.baselineRmssd) / feedback.baselineRmssd) * 100;
          const improved = pct >= 0;
          const color = improved ? '#00E676' : '#FF5252';
          const bg = improved ? 'rgba(0,230,118,0.15)' : 'rgba(255,82,82,0.15)';
          return (
            <View style={[styles.improvementBadge, {backgroundColor: bg, borderColor: color}]}>
              <Text style={[styles.improvementPct, {color}]}>
                {improved ? '+' : ''}{pct.toFixed(1)}%
              </Text>
            </View>
          );
        })()}

        {/* Record Button */}
        <TouchableOpacity
          style={[
            styles.button,
            isRecording ? styles.buttonStop : styles.buttonRecord,
            !isConnected && styles.buttonDisabled,
          ]}
          onPress={handleRecording}
          disabled={!isConnected}
          activeOpacity={0.7}>
          <Text style={styles.buttonText}>
            {isRecording ? 'End Session' : 'Start Session'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </ImageBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  bgOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,5,30,0.50)',
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: 8,
  },
  scrollContainer: {
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 8 : 16,
    paddingBottom: 24,
  },
  header: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.75)',
    fontFamily: 'monospace',
  },
  apiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  apiLabel: {
    fontSize: 12,
    color: 'rgba(180, 160, 255, 0.65)',
    marginRight: 8,
    fontFamily: 'monospace',
  },
  apiInput: {
    flex: 1,
    backgroundColor: 'rgba(30, 20, 60, 0.7)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#e0d8ff',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.3)',
  },
  chartContainer: {
    alignItems: 'center',
    marginVertical: 4,
  },
  hrvPanel: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 14,
    padding: 14,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
  },
  hrvTitle: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.7)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    fontWeight: '600',
  },
  currentHRV: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  hrvValue: {
    fontSize: 52,
    fontWeight: '800',
    color: '#00E676',
    fontFamily: 'monospace',
  },
  hrvUnit: {
    fontSize: 22,
    color: '#00E676',
    marginLeft: 8,
    fontFamily: 'monospace',
  },
  hrvWaiting: {
    fontSize: 15,
    color: 'rgba(180, 160, 255, 0.6)',
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  analyzingText: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.7)',
    textAlign: 'center',
    marginTop: 4,
    fontFamily: 'monospace',
  },
  historySection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(180, 150, 255, 0.2)',
    paddingTop: 10,
  },
  historyTitle: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.6)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    fontWeight: '600',
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  historyTime: {
    fontSize: 12,
    color: 'rgba(180, 160, 255, 0.6)',
    fontFamily: 'monospace',
    flex: 1,
  },
  historyValue: {
    fontSize: 14,
    color: '#00E676',
    fontFamily: 'monospace',
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
  historyError: {
    fontSize: 12,
    color: '#FF5252',
    fontFamily: 'monospace',
    flex: 1,
    textAlign: 'right',
  },
  historySegments: {
    fontSize: 11,
    color: 'rgba(160, 140, 220, 0.55)',
    fontFamily: 'monospace',
    width: 80,
    textAlign: 'right',
  },
  button: {
    paddingVertical: 18,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  buttonRecord: {
    backgroundColor: 'rgba(0, 200, 83, 0.9)',
  },
  buttonStop: {
    backgroundColor: 'rgba(255, 82, 82, 0.9)',
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  cycleModeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(180,150,255,0.12)',
  },
  badSegmentBadge: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,214,0,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,214,0,0.5)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
  },
  badSegmentText: {
    color: '#FFD600',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  trafficLightWrapperLarge: {
    paddingVertical: 48,
  },
  trafficLightLarge: {
    width: 160,
    borderRadius: 80,
    paddingVertical: 28,
    paddingHorizontal: 18,
    gap: 20,
  },
  trafficBulbLarge: {
    width: 110,
    height: 110,
    borderRadius: 55,
  },
  // Header back button
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  backBtn: {padding: 4},
  trafficLightWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
  },
  trafficLight: {
    width: 130,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 65,
    paddingVertical: 20,
    paddingHorizontal: 14,
    alignItems: 'center',
    gap: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  trafficBulb: {
    width: 86,
    height: 86,
    borderRadius: 43,
  },
  improvementBadge: {
    alignSelf: 'center',
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 20,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  improvementPct: {
    fontSize: 24,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  summaryCard: {
    backgroundColor: 'rgba(40, 25, 80, 0.85)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.35)',
    padding: 16,
    marginVertical: 10,
    marginHorizontal: 4,
  },
  summaryTitle: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.7)',
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 12,
    textAlign: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  summaryLabel: {
    fontSize: 12,
    color: 'rgba(180, 160, 255, 0.65)',
    fontFamily: 'monospace',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  summaryBaselineValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#B4A0FF',
    fontFamily: 'monospace',
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  infoBtn: {
    padding: 4,
    marginLeft: 4,
  },
  collectingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(80, 55, 160, 0.55)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
    padding: 12,
    marginVertical: 6,
  },
  collectingText: {
    fontSize: 12,
    color: 'rgba(210, 190, 255, 0.9)',
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  collectingTrack: {
    height: 4,
    backgroundColor: 'rgba(180, 150, 255, 0.2)',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 5,
  },
  collectingFill: {
    height: 4,
    backgroundColor: 'rgba(180, 150, 255, 0.75)',
    borderRadius: 2,
  },
  collectingHint: {
    fontSize: 11,
    color: 'rgba(180, 160, 255, 0.55)',
    fontFamily: 'monospace',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 2, 20, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  modalCard: {
    backgroundColor: 'rgba(40, 25, 90, 0.97)',
    borderRadius: 14,
    padding: 24,
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.35)',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 14,
    letterSpacing: 0.3,
  },
  modalBody: {
    fontSize: 14,
    color: 'rgba(210, 190, 255, 0.88)',
    lineHeight: 22,
    fontFamily: 'monospace',
    marginBottom: 20,
  },
  modalBtn: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(120, 80, 220, 0.6)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.4)',
  },
  modalBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
});

export default HRVScreen;
