import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  Platform,
  TextInput,
} from 'react-native';
import {bleService} from '../services/BleService';
import PPGChart from '../components/PPGChart';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {useAppContext} from '../context/AppContext';

const WINDOW_SIZE = 600;
const RATE_WINDOW_SEC = 5;

interface Props {
  onBack: () => void;
}

const PPGMonitorScreen: React.FC<Props> = ({onBack}) => {
  const {apiUrl, setApiUrl} = useAppContext();
  const [status, setStatus] = useState(bleService.connected ? 'Connected. Streaming...' : 'Idle');
  const [isConnected, setIsConnected] = useState(bleService.connected);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);

  // Use refs for high-frequency data to avoid React re-renders
  const dataRef = useRef<number[]>([]);
  const statsRef = useRef({totalSamples: 0, rate: 0, lastRxAge: 0});

  // Rate tracking
  const rateCounterRef = useRef(0);
  const rateWindowStartRef = useRef(Date.now());
  const lastRxTimeRef = useRef(0);

  const screenWidth = Dimensions.get('window').width;
  const chartHeight = 300;

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
      // Reset every RATE_WINDOW_SEC
      if (elapsed >= RATE_WINDOW_SEC) {
        rateCounterRef.current = 0;
        rateWindowStartRef.current = now;
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Handle incoming PPG data - stored in ref to avoid re-renders
  const handleData = useCallback((samples: number[]) => {
    if (!isRecordingRef.current) return;
    const data = dataRef.current;
    for (let i = 0; i < samples.length; i++) {
      data.push(samples[i]);
    }
    // Keep only last WINDOW_SIZE samples
    if (data.length > WINDOW_SIZE + 100) {
      dataRef.current = data.slice(-WINDOW_SIZE);
    }
    statsRef.current.totalSamples += samples.length;
    rateCounterRef.current += samples.length;
    lastRxTimeRef.current = Date.now();
  }, []);

  // Set up BLE callbacks
  useEffect(() => {
    bleService.setOnData(handleData);
    bleService.setOnStatusChange((newStatus: string) => {
      setStatus(newStatus);
      const connected = newStatus.includes('Streaming');
      setIsConnected(connected);
    });

    return () => {
      bleService.setOnData(() => {});
      bleService.setOnStatusChange(() => {});
    };
  }, [handleData]);

  const handleRecording = useCallback(() => {
    if (isRecording) {
      isRecordingRef.current = false;
      setIsRecording(false);
      setStatus('Stopped');
    } else {
      dataRef.current = [];
      statsRef.current = {totalSamples: 0, rate: 0, lastRxAge: 0};
      rateCounterRef.current = 0;
      rateWindowStartRef.current = Date.now();
      isRecordingRef.current = true;
      setIsRecording(true);
      setStatus('Recording...');
    }
  }, [isRecording]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d1a" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn} activeOpacity={0.7}>
            <Icon name="arrow-left" size={26} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.title}>PPG Live Monitor</Text>
        </View>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              {backgroundColor: isConnected ? '#00E676' : '#FF5252'},
            ]}
          />
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </View>

      {/* API URL */}
      <View style={styles.apiRow}>
        <Text style={styles.apiLabel}>API URL</Text>
        <TextInput
          style={styles.apiInput}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="http://192.168.1.100:8000"
          placeholderTextColor="#444466"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Chart */}
      <View style={styles.chartContainer}>
        <PPGChart
          width={screenWidth - 16}
          height={chartHeight}
          dataRef={dataRef}
          statsRef={statsRef}
          showStats
          showYAxisLabels
        />
      </View>

      {/* Info panel */}
      <View style={styles.infoPanel}>
        <View style={styles.infoRow}>
          <InfoItem label="Device" value="NanoESP32_PPG" />
          <InfoItem label="Sample Rate" value="100 Hz" />
        </View>
        <View style={styles.infoRow}>
          <InfoItem label="Window" value={`${WINDOW_SIZE} samples`} />
          <InfoItem label="Batch Size" value="4 samples/pkt" />
        </View>
      </View>

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
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const InfoItem: React.FC<{label: string; value: string}> = ({label, value}) => (
  <View style={styles.infoItem}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text style={styles.infoValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
    paddingHorizontal: 8,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 8 : 16,
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
  backBtn: {
    padding: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    marginLeft: 38,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 13,
    color: '#aaaacc',
    fontFamily: 'monospace',
  },
  apiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 8,
    gap: 8,
  },
  apiLabel: {
    fontSize: 12,
    color: '#6666aa',
    fontFamily: 'monospace',
    fontWeight: '600',
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
    marginVertical: 8,
  },
  infoPanel: {
    backgroundColor: '#16162a',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  infoItem: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 11,
    color: '#6666aa',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 14,
    color: '#ccccee',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  button: {
    marginTop: 12,
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
});

export default PPGMonitorScreen;
