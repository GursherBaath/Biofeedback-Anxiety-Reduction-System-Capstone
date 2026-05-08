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
import {
  amplitudeStart,
  amplitudeSendData,
  amplitudeStop,
  AmplitudeStopResult,
} from '../services/AmplitudeService';
import {saveSession, saveDemoSessionRecord} from '../services/SessionStorageService';
import {useAppContext} from '../context/AppContext';
import PPGChart from '../components/PPGChart';
import AmplitudeCharts, {AmplitudeChartsData} from '../components/AmplitudeCharts';
import {initSounds, playFeedbackSound, releaseSounds} from '../services/SoundService';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

const CHART_WINDOW = 600;
const SEND_INTERVAL_MS = 1000; // send data every 1 second

const FEEDBACK_COLORS: Record<string, string> = {
  green: '#00E676',
  yellow: '#FFD600',
  red: '#FF5252',
};

const AmplitudeScreen: React.FC = () => {
  const [status, setStatus] = useState('Ready');
  const [isConnected, setIsConnected] = useState(bleService.connected);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const {apiUrl, exitSession, isDemoMode} = useAppContext();
  const [currentHR, setCurrentHR] = useState<number | null>(null);
  const [latestAmplitude, setLatestAmplitude] = useState<number | null>(null);
  const [latestColor, setLatestColor] = useState<string>('green');
  const [latestBreathingRate, setLatestBreathingRate] = useState<number | null>(null);
  const [signalQuality, setSignalQuality] = useState('ACTIVE');

  const [summary, setSummary] = useState<AmplitudeStopResult | null>(null);
  const [isPPGVisible, setIsPPGVisible] = useState(true);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
  const [isInfoVisible, setIsInfoVisible] = useState(false);

  // Data refs
  const dataRef = useRef<number[]>([]);
  const statsRef = useRef({totalSamples: 0, rate: 0, lastRxAge: 0});

  // Pending samples buffer — accumulated between sends
  const pendingSamplesRef = useRef<number[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const hadConnectionRef = useRef(bleService.connected);
  const disconnectHandledRef = useRef(false);
  const disconnectedDuringSessionRef = useRef(false);

  // Chart data ref for AmplitudeCharts
  const chartDataRef = useRef<AmplitudeChartsData>({hrSeries: [], events: []});

  // Rate tracking
  const rateCounterRef = useRef(0);
  const rateWindowStartRef = useRef(Date.now());
  const lastRxTimeRef = useRef(0);

  // Timer refs
  const sendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const screenWidth = Dimensions.get('window').width;
  const chartHeight = 110;

  // Load sounds
  useEffect(() => {
    initSounds();
    return () => releaseSounds();
  }, []);

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
      if (elapsed >= 5) {
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

    // Accumulate for API send
    const pending = pendingSamplesRef.current;
    for (let i = 0; i < samples.length; i++) {
      pending.push(samples[i]);
    }

    // Update stats
    statsRef.current.totalSamples += samples.length;
    rateCounterRef.current += samples.length;
    lastRxTimeRef.current = Date.now();
  }, []);

  // Send accumulated samples to API
  const sendPending = useCallback(async () => {
    if (!isRecordingRef.current) {
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) {
      return;
    }

    const samples = pendingSamplesRef.current;
    if (samples.length === 0) {
      return;
    }
    // Take and clear
    pendingSamplesRef.current = [];

    try {
      const result = await amplitudeSendData(apiUrl, sid, samples);
      if (result.hr != null) {
        setCurrentHR(result.hr);
      }
      setSignalQuality(result.signal_quality);

      // Accumulate HR data for charts
      if (result.hr_data && result.hr_data.length > 0) {
        const cd = chartDataRef.current;
        cd.hrSeries = cd.hrSeries.concat(result.hr_data);
      }

      if (result.events.length > 0) {
        // Accumulate events for charts
        const cd = chartDataRef.current;
        cd.events = cd.events.concat(result.events);

        const latest = result.events[result.events.length - 1];
        playFeedbackSound(latest.feedback_color);
        setLatestAmplitude(latest.amplitude);
        setLatestColor(latest.feedback_color);
        setLatestBreathingRate(latest.breathing_rate_bpm);
      }
    } catch (e: any) {
      console.log('[Amplitude] send error:', e.message);
    }
  }, [apiUrl]);

  // Register BLE listener
  useEffect(() => {
    bleService.addOnData('amplitude', handleData);
    bleService.addOnStatusChange('amplitude', (newStatus: string) => {
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

      if (sendTimerRef.current) {
        clearInterval(sendTimerRef.current);
        sendTimerRef.current = null;
      }

      isRecordingRef.current = false;
      setIsRecording(false);
      pendingSamplesRef.current = [];
      setStatus('Connection lost');

      if (sessionIdRef.current) {
        const sid = sessionIdRef.current;
        sessionIdRef.current = null;
        amplitudeStop(apiUrl, sid).catch(() => {});
      }

      Alert.alert(
        'Device disconnected',
        'Connection lost. Returning to the main screen. This session was not saved.',
        [{text: 'OK', onPress: exitSession}],
        {cancelable: false},
      );
    });

    if (bleService.connected) {
      setIsConnected(true);
    }

    return () => {
      bleService.removeOnData('amplitude');
      bleService.removeOnStatusChange('amplitude');
    };
  }, [handleData]);

  // Start/stop send timer based on recording state
  useEffect(() => {
    if (isRecording) {
      sendTimerRef.current = setInterval(() => {
        sendPending();
      }, SEND_INTERVAL_MS);
    } else {
      if (sendTimerRef.current) {
        clearInterval(sendTimerRef.current);
        sendTimerRef.current = null;
      }
    }

    return () => {
      if (sendTimerRef.current) {
        clearInterval(sendTimerRef.current);
        sendTimerRef.current = null;
      }
    };
  }, [isRecording, sendPending]);

  const handleRecording = useCallback(async () => {
    if (isRecording) {
      if (disconnectedDuringSessionRef.current) {
        disconnectedDuringSessionRef.current = false;
        setStatus('Session canceled');
        return;
      }

      // Stop session
      if (sendTimerRef.current) {
        clearInterval(sendTimerRef.current);
        sendTimerRef.current = null;
      }
      isRecordingRef.current = false;
      setIsRecording(false);
      pendingSamplesRef.current = [];

      const endTime = Date.now();
      const durSeconds = Math.round((endTime - recordingStartTimeRef.current) / 1000);
      const save = isDemoMode ? saveDemoSessionRecord : saveSession;
      if (sessionIdRef.current) {
        try {
          const stopResult = await amplitudeStop(apiUrl, sessionIdRef.current);
          setSummary(stopResult);
          save({
            id: recordingStartTimeRef.current.toString(),
            type: 'amplitude',
            startTime: recordingStartTimeRef.current,
            endTime,
            durSeconds,
            meanHR: stopResult.mean_hr ?? undefined,
            meanAmplitude: stopResult.mean_amplitude ?? undefined,
          });
        } catch (e: any) {
          console.log('[Amplitude] stop error:', e.message);
          save({
            id: recordingStartTimeRef.current.toString(),
            type: 'amplitude',
            startTime: recordingStartTimeRef.current,
            endTime,
            durSeconds,
          });
        }
        sessionIdRef.current = null;
      }
      statsRef.current = {totalSamples: statsRef.current.totalSamples, rate: 0, lastRxAge: 0};
      lastRxTimeRef.current = 0;
      rateCounterRef.current = 0;
      setStatus('Session ended');
      return;
    }

    setSummary(null);
    dataRef.current = [];
    pendingSamplesRef.current = [];
    chartDataRef.current = {hrSeries: [], events: []};
    statsRef.current = {totalSamples: 0, rate: 0, lastRxAge: 0};
    rateCounterRef.current = 0;
    rateWindowStartRef.current = Date.now();
    setCurrentHR(null);
    setLatestAmplitude(null);
    setLatestColor('green');
    setLatestBreathingRate(null);
    setSignalQuality('ACTIVE');
    disconnectedDuringSessionRef.current = false;

    try {
      const sid = await amplitudeStart(apiUrl);
      sessionIdRef.current = sid;
      recordingStartTimeRef.current = Date.now();
      console.log('[Amplitude] session started:', sid);
      isRecordingRef.current = true;
      setIsRecording(true);
      setStatus('Session active');
    } catch (e: any) {
      console.log('[Amplitude] start error:', e.message);
      setStatus('Session start failed');
    }
  }, [isRecording, apiUrl]);

  const showAmplitudeInfo = useCallback(() => {
    setIsInfoVisible(true);
  }, []);

  const isBadSignal = signalQuality.includes('PAUSED');

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
            <Text style={styles.modalTitle}>RSA Amplitude</Text>
            <Text style={styles.modalBody}>
              {'Sync your breathing to the heart rate graph:\n\n↑  Breathe IN as the graph rises\n↓  Breathe OUT as it falls\n\nAim for ~5-second inhales and exhales.'}
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
            <Text style={styles.title}>RSA Amplitude</Text>
            <TouchableOpacity onPress={showAmplitudeInfo} style={styles.infoBtn} activeOpacity={0.7}>
              <Icon name="information-outline" size={22} color="rgba(200, 180, 255, 0.85)" />
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

        {/* PPG Chart */}
        <TouchableOpacity
          style={styles.ppgToggle}
          onPress={() => setIsPPGVisible(v => !v)}
          activeOpacity={0.5}>
          <View style={styles.ppgToggleLine} />
          <Icon name={isPPGVisible ? 'chevron-up' : 'chevron-down'} size={14} color="rgba(180, 150, 255, 0.35)" />
          <View style={styles.ppgToggleLine} />
        </TouchableOpacity>
        {isPPGVisible && (
          <View style={styles.chartContainer}>
            <PPGChart
              width={screenWidth - 16}
              height={chartHeight}
              dataRef={dataRef}
              statsRef={statsRef}
              showStats={false}
              showYAxisLabels={false}
              showGridLines={false}
            />
          </View>
        )}

        {/* HR / Amplitude / Breathing Rate Charts */}
        <View style={styles.chartContainer}>
          <AmplitudeCharts
            viewportWidth={screenWidth - 16}
            height={400}
            dataRef={chartDataRef}
            isStreaming={isConnected}
          />
        </View>

        {/* Signal Quality Badge — only visible when signal is paused/bad */}
        {isBadSignal && (
          <View style={styles.sqiBadgeBad}>
            <Text style={styles.sqiTextBad}>{signalQuality}</Text>
          </View>
        )}

        {/* Live Metrics Panel */}
        <View style={styles.metricsPanel}>
          {/* HR */}
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>HEART RATE</Text>
            {currentHR != null ? (
              <View style={styles.metricRow}>
                <Text style={styles.metricValue}>{currentHR.toFixed(0)}</Text>
                <Text style={styles.metricUnit}>bpm</Text>
              </View>
            ) : (
              <Text style={styles.metricWaiting}>--</Text>
            )}
          </View>

          {/* Amplitude circle */}
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>AMPLITUDE</Text>
            {latestAmplitude != null ? (
              <View
                style={[
                  styles.amplitudeCircle,
                  {borderColor: FEEDBACK_COLORS[latestColor]},
                ]}>
                <Text
                  style={[
                    styles.amplitudeValue,
                    {color: FEEDBACK_COLORS[latestColor]},
                  ]}>
                  {latestAmplitude.toFixed(1)}
                </Text>
                <Text
                  style={[
                    styles.amplitudeUnit,
                    {color: FEEDBACK_COLORS[latestColor]},
                  ]}>
                  BPM
                </Text>
              </View>
            ) : (
              <Text style={styles.metricWaiting}>--</Text>
            )}
          </View>

          {/* Breathing Rate */}
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>BREATHING</Text>
            {latestBreathingRate != null ? (
              <View style={styles.metricRow}>
                <Text style={styles.metricValue}>
                  {latestBreathingRate.toFixed(1)}
                </Text>
                <Text style={styles.metricUnit}>br/min</Text>
              </View>
            ) : (
              <Text style={styles.metricWaiting}>--</Text>
            )}
          </View>
        </View>

        {/* Session Summary (shown after disconnect) */}
        {summary && (
          <View style={styles.summaryPanel}>
            <Text style={styles.summaryTitle}>SESSION SUMMARY</Text>
            {summary.mean_amplitude != null && (
              <SummaryRow label="Mean Amplitude" value={`${summary.mean_amplitude.toFixed(2)} BPM`} />
            )}
            {summary.mean_breathing_rate != null && (
              <SummaryRow
                label="Mean Breathing Rate"
                value={`${summary.mean_breathing_rate.toFixed(1)} br/min`}
              />
            )}
            <TouchableOpacity
              style={styles.expandBtn}
              onPress={() => setIsSummaryExpanded(v => !v)}
              activeOpacity={0.7}>
              <Text style={styles.expandBtnText}>
                {isSummaryExpanded ? 'Less detail ▲' : 'More detail ▼'}
              </Text>
            </TouchableOpacity>
            {isSummaryExpanded && (
              <>
                {summary.mean_hr != null && (
                  <>
                    <SummaryRow label="Mean HR" value={`${summary.mean_hr.toFixed(1)} bpm`} />
                    <SummaryRow label="Min HR" value={`${summary.min_hr!.toFixed(1)} bpm`} />
                    <SummaryRow label="Max HR" value={`${summary.max_hr!.toFixed(1)} bpm`} />
                  </>
                )}
                {summary.min_amplitude != null && (
                  <>
                    <SummaryRow label="Min Amplitude" value={`${summary.min_amplitude.toFixed(2)} BPM`} />
                    <SummaryRow label="Max Amplitude" value={`${summary.max_amplitude!.toFixed(2)} BPM`} />
                  </>
                )}
              </>
            )}
          </View>
        )}

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

const SummaryRow: React.FC<{label: string; value: string}> = ({label, value}) => (
  <View style={styles.summaryRow}>
    <Text style={styles.summaryLabel}>{label}</Text>
    <Text style={styles.summaryValue}>{value}</Text>
  </View>
);

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
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  backBtn: {padding: 4},
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
    color: '#6666aa',
    marginRight: 8,
    fontFamily: 'monospace',
  },
  apiInput: {
    flex: 1,
    backgroundColor: '#16162a',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#ccccee',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  chartContainer: {
    alignItems: 'center',
    marginVertical: 4,
  },
  sqiBadge: {
    alignSelf: 'center',
    backgroundColor: 'rgba(30, 20, 60, 0.7)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: '#00E676',
  },
  sqiBadgeBad: {
    borderColor: '#FF5252',
    backgroundColor: 'rgba(90, 20, 40, 0.72)',
  },
  sqiText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#00E676',
    fontWeight: '600',
  },
  sqiTextBad: {
    color: '#FF5252',
  },
  metricsPanel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 8,
    paddingHorizontal: 4,
  },
  metricBox: {
    flex: 1,
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 3,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
  },
  metricLabel: {
    fontSize: 10,
    color: 'rgba(200, 180, 255, 0.70)',
    letterSpacing: 0,
    marginBottom: 6,
    width: '100%',
    textAlign: 'center',
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  metricValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
    fontFamily: 'monospace',
  },
  metricUnit: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.70)',
    marginLeft: 3,
    fontFamily: 'monospace',
  },
  metricWaiting: {
    fontSize: 28,
    color: 'rgba(180, 160, 255, 0.50)',
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  amplitudeCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amplitudeValue: {
    fontSize: 22,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  amplitudeUnit: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  summaryPanel: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
  },
  summaryTitle: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.70)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    fontWeight: '600',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  summaryLabel: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.72)',
    fontFamily: 'monospace',
  },
  summaryValue: {
    fontSize: 13,
    color: '#ffffff',
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  historySection: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
  },
  historyTitle: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.70)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  historyTime: {
    fontSize: 12,
    color: 'rgba(180, 160, 255, 0.70)',
    fontFamily: 'monospace',
    width: 60,
  },
  historyValue: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  historyBreathing: {
    fontSize: 12,
    color: 'rgba(180, 160, 255, 0.70)',
    fontFamily: 'monospace',
    width: 90,
    textAlign: 'right',
  },
  button: {
    marginTop: 8,
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRecord: {
    backgroundColor: '#00C853',
  },
  buttonStop: {
    backgroundColor: '#FF5252',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  ppgToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
    paddingVertical: 4,
    paddingHorizontal: 8,
    gap: 6,
  },
  ppgToggleLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(180, 150, 255, 0.15)',
  },
  infoBtn: {
    padding: 4,
    marginLeft: 4,
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
  expandBtn: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  expandBtnText: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.70)',
    fontFamily: 'monospace',
  },
});

export default AmplitudeScreen;
