import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  ImageBackground,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  loadSessions,
  loadDemoSessions,
  buildDemoSessions,
  groupByWeek,
  formatDuration,
  formatWeekLabel,
  Session,
} from '../services/SessionStorageService';
import {useAppContext} from '../context/AppContext';

interface Props {
  onBack: () => void;
}

interface WeekStats {
  sessionCount: number;
  totalSeconds: number;
  avgBaselineRmssd: number | null;
  avgSessionImprovementPct: number | null;
  avgHR: number | null;
  avgAmplitude: number | null;
  weekLabel: string;
  sessions: Session[];
}

interface FeedbackStats {
  current: WeekStats;
  previous: WeekStats | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildWeekStats(weekStart: Date, sessions: Session[]): WeekStats {
  const totalSeconds = sessions.reduce((s, x) => s + x.durSeconds, 0);
  const hrVals = sessions.filter(s => s.meanHR != null).map(s => s.meanHR as number);
  const baselineVals = sessions
    .filter(s => s.baselineRmssd != null)
    .map(s => s.baselineRmssd as number);
  const improvementVals = sessions
    .filter(s => s.rmssdImprovementPct != null)
    .map(s => s.rmssdImprovementPct as number);
  const ampVals = sessions
    .filter(s => s.meanAmplitude != null)
    .map(s => s.meanAmplitude as number);

  return {
    sessionCount: sessions.length,
    totalSeconds,
    avgBaselineRmssd: average(baselineVals),
    avgSessionImprovementPct: average(improvementVals),
    avgHR: average(hrVals),
    avgAmplitude: average(ampVals),
    weekLabel: formatWeekLabel(weekStart),
    sessions,
  };
}

function computeStats(groups: {weekStart: Date; sessions: Session[]}[]): FeedbackStats | null {
  if (groups.length === 0) return null;
  const current = buildWeekStats(groups[0].weekStart, groups[0].sessions);
  const previous =
    groups.length > 1
      ? buildWeekStats(groups[1].weekStart, groups[1].sessions)
      : null;
  return {current, previous};
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function wowDelta(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null) return null;
  return curr - prev;
}

function improvementNote(pct: number | null): string {
  if (pct == null) return 'No improvement data yet this week';
  if (pct >= 10) return 'Strong improvement this week';
  if (pct >= 0) return 'HRV held steady or improved during sessions';
  return 'Slight decrease this week — normal variation';
}

function wowNote(delta: number | null, unit: string): string {
  if (delta == null) return 'Need another week to show a comparison';
  if (Math.abs(delta) < 1) return `About the same as last week`;
  return delta > 0
    ? `Up ${Math.abs(delta).toFixed(1)}${unit} from last week`
    : `Down ${Math.abs(delta).toFixed(1)}${unit} from last week`;
}

const WeeklyInsightsScreen: React.FC<Props> = ({onBack}) => {
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const {isDemoMode} = useAppContext();

  const reload = useCallback(async () => {
    setLoading(true);
    let sessions;
    if (isDemoMode) {
      const stored = await loadDemoSessions();
      sessions = [...buildDemoSessions(), ...stored];
    } else {
      sessions = await loadSessions();
    }
    const groups = groupByWeek(sessions);
    setStats(computeStats(groups));
    setLoading(false);
  }, [isDemoMode]);

  useEffect(() => {
    reload();
  }, [reload]);

  const current = stats?.current ?? null;
  const previous = stats?.previous ?? null;

  const baseline = current?.avgBaselineRmssd ?? null;
  const sessionImprovement = current?.avgSessionImprovementPct ?? null;
  const avgAmplitude = current?.avgAmplitude ?? null;

  const baselineDelta = wowDelta(
    current?.avgBaselineRmssd ?? null,
    previous?.avgBaselineRmssd ?? null,
  );
  const improvementDelta = wowDelta(
    current?.avgSessionImprovementPct ?? null,
    previous?.avgSessionImprovementPct ?? null,
  );
  const amplitudeDelta = wowDelta(
    current?.avgAmplitude ?? null,
    previous?.avgAmplitude ?? null,
  );

  const improvColor = sessionImprovement != null && sessionImprovement >= 0 ? '#00E676' : '#FFD600';
  const baselineDeltaColor = baselineDelta == null ? '#c0b0ff' : baselineDelta >= 0 ? '#00E676' : '#FFD600';
  const improvDeltaColor = improvementDelta == null ? '#c0b0ff' : improvementDelta >= 0 ? '#00E676' : '#FFD600';
  const amplitudeDeltaColor = amplitudeDelta == null ? '#c0b0ff' : amplitudeDelta >= 0 ? '#00E676' : '#FFD600';

  return (
    <ImageBackground
      source={require('../assets/images/background2.jpg')}
      style={styles.bg}
      resizeMode="cover">
      <View style={styles.overlay} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} activeOpacity={0.7}>
          <Icon name="arrow-left" size={28} color="#ffffff" />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Weekly Feedback</Text>
          {current && !loading && (
            <Text style={styles.headerSub}>{current.weekLabel}</Text>
          )}
        </View>
      </View>

      {isDemoMode && (
        <View style={styles.demoBanner}>
          <Text style={styles.demoBannerText}>DEMO MODE</Text>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {loading ? (
          <ActivityIndicator color="#c0b0ff" size="large" style={styles.loader} />
        ) : stats == null || current == null ? (
          <View style={styles.emptyContainer}>
            <Icon name="chart-line-variant" size={64} color="rgba(180,160,255,0.4)" />
            <Text style={styles.emptyText}>No sessions yet</Text>
            <Text style={styles.emptySubText}>
              Complete an HRV recording to see your feedback
            </Text>
          </View>
        ) : (
          <>
            {/* Activity summary */}
            <View style={styles.summaryRow}>
              <View style={styles.summaryChip}>
                <Text style={styles.summaryChipValue}>{current.sessionCount}</Text>
                <Text style={styles.summaryChipLabel}>Sessions</Text>
              </View>
              <View style={styles.summaryChip}>
                <Text style={styles.summaryChipValue}>{formatDuration(current.totalSeconds)}</Text>
                <Text style={styles.summaryChipLabel}>Total Time</Text>
              </View>
            </View>

            {/* Session Improvement — main focus */}
            <View style={styles.mainCard}>
              <Text style={styles.mainCardLabel}>SESSION IMPROVEMENT</Text>
              <Text style={[styles.mainCardValue, {color: improvColor}]}>
                {sessionImprovement != null ? formatPct(sessionImprovement) : '--'}
              </Text>
              <Text style={styles.mainCardSub}>
                Avg change from start to end of each HRV session
              </Text>
              <View style={styles.divider} />
              <Text style={styles.noteText}>{improvementNote(sessionImprovement)}</Text>
            </View>

            {/* Baseline RMSSD */}
            <View style={styles.metricCard}>
              <View style={styles.metricCardHeader}>
                <Text style={styles.metricCardLabel}>BASELINE RMSSD</Text>
                <Text style={styles.metricCardValue}>
                  {baseline != null ? `${baseline.toFixed(1)} ms` : '--'}
                </Text>
              </View>
              <Text style={styles.metricCardSub}>
                Average RMSSD at the start of sessions this week
              </Text>
            </View>

            {/* RSA Amplitude */}
            <View style={styles.metricCard}>
              <View style={styles.metricCardHeader}>
                <Text style={styles.metricCardLabel}>RSA AMPLITUDE</Text>
                <Text style={[styles.metricCardValue, {color: '#FF9800'}]}>
                  {avgAmplitude != null ? `${avgAmplitude.toFixed(1)} bpm` : '--'}
                </Text>
              </View>
              <Text style={styles.metricCardSub}>
                Average peak-to-trough heart rate swing during breathing
              </Text>
            </View>

            {/* Week over week */}
            <View style={styles.wowCard}>
              <Text style={styles.wowTitle}>COMPARED TO LAST WEEK</Text>

              <View style={styles.wowRow}>
                <View style={styles.wowLeft}>
                  <Text style={styles.wowRowLabel}>Baseline RMSSD</Text>
                  <Text style={styles.wowRowNote}>{wowNote(baselineDelta, ' ms')}</Text>
                </View>
                <Text style={[styles.wowRowValue, {color: baselineDeltaColor}]}>
                  {baselineDelta != null
                    ? `${baselineDelta >= 0 ? '+' : ''}${baselineDelta.toFixed(1)} ms`
                    : '--'}
                </Text>
              </View>

              <View style={styles.wowRow}>
                <View style={styles.wowLeft}>
                  <Text style={styles.wowRowLabel}>Session Improvement</Text>
                  <Text style={styles.wowRowNote}>{wowNote(improvementDelta, '%')}</Text>
                </View>
                <Text style={[styles.wowRowValue, {color: improvDeltaColor}]}>
                  {improvementDelta != null
                    ? `${improvementDelta >= 0 ? '+' : ''}${improvementDelta.toFixed(1)}%`
                    : '--'}
                </Text>
              </View>

              <View style={[styles.wowRow, {borderBottomWidth: 0}]}>
                <View style={styles.wowLeft}>
                  <Text style={styles.wowRowLabel}>RSA Amplitude</Text>
                  <Text style={styles.wowRowNote}>{wowNote(amplitudeDelta, ' bpm')}</Text>
                </View>
                <Text style={[styles.wowRowValue, {color: amplitudeDeltaColor}]}>
                  {amplitudeDelta != null
                    ? `${amplitudeDelta >= 0 ? '+' : ''}${amplitudeDelta.toFixed(1)} bpm`
                    : '--'}
                </Text>
              </View>
            </View>

            {/* Encouragement */}
            <View style={styles.encourageCard}>
              <Icon name="star-four-points" size={22} color="#FFD600" />
              <Text style={styles.encourageText}>
                {current.sessionCount >= 5
                  ? "Great consistency this week."
                  : current.sessionCount >= 3
                  ? "Good effort — aim for 5+ sessions next week."
                  : "Every session builds the picture."}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </ImageBackground>
  );
};

const styles = StyleSheet.create({
  bg: {flex: 1, width: '100%', height: '100%'},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,5,30,0.45)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backBtn: {marginRight: 14, padding: 4},
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  headerSub: {
    fontSize: 14,
    color: 'rgba(200, 180, 255, 0.7)',
    marginTop: 2,
  },
  scroll: {flex: 1},
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    gap: 14,
  },
  loader: {marginTop: 80},
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyText: {
    fontSize: 18,
    color: 'rgba(200, 180, 255, 0.85)',
    fontWeight: '700',
  },
  emptySubText: {
    fontSize: 14,
    color: 'rgba(180, 160, 255, 0.55)',
    textAlign: 'center',
    paddingHorizontal: 30,
  },
  // Activity summary row
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
  },
  summaryChip: {
    flex: 1,
    backgroundColor: 'rgba(80, 55, 160, 0.55)',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.2)',
  },
  summaryChipValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#ffffff',
  },
  summaryChipLabel: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.65)',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  // Main focus card — session improvement
  mainCard: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 16,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
    alignItems: 'center',
  },
  mainCardLabel: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.65)',
    letterSpacing: 1,
    fontWeight: '700',
    marginBottom: 6,
  },
  mainCardValue: {
    fontSize: 60,
    fontWeight: '800',
    lineHeight: 68,
  },
  mainCardSub: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.6)',
    marginTop: 4,
    textAlign: 'center',
  },
  divider: {
    width: '60%',
    height: 1,
    backgroundColor: 'rgba(180, 150, 255, 0.2)',
    marginVertical: 12,
  },
  noteText: {
    fontSize: 15,
    color: 'rgba(220, 210, 255, 0.85)',
    fontWeight: '600',
    textAlign: 'center',
  },
  // Baseline metric card
  metricCard: {
    backgroundColor: 'rgba(80, 55, 160, 0.55)',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.2)',
  },
  metricCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metricCardLabel: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.65)',
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  metricCardValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#ffffff',
  },
  metricCardSub: {
    fontSize: 13,
    color: 'rgba(200, 180, 255, 0.55)',
    marginTop: 4,
  },
  // Week-over-week card
  wowCard: {
    backgroundColor: 'rgba(80, 55, 160, 0.55)',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.2)',
    gap: 2,
  },
  wowTitle: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.65)',
    letterSpacing: 0.8,
    fontWeight: '700',
    marginBottom: 8,
  },
  wowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(180, 150, 255, 0.15)',
  },
  wowLeft: {flex: 1, paddingRight: 12},
  wowRowLabel: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '700',
  },
  wowRowNote: {
    fontSize: 12,
    color: 'rgba(200, 180, 255, 0.55)',
    marginTop: 2,
  },
  wowRowValue: {
    fontSize: 20,
    fontWeight: '800',
  },
  // Encouragement
  encourageCard: {
    backgroundColor: 'rgba(100, 70, 200, 0.45)',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 0, 0.2)',
  },
  encourageText: {
    flex: 1,
    fontSize: 14,
    color: 'rgba(255, 245, 200, 0.85)',
    fontWeight: '600',
    lineHeight: 20,
  },
  demoBanner: {
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 165, 0, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255, 200, 0, 0.45)',
  },
  demoBannerText: {
    color: '#FFD600',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
});

export default WeeklyInsightsScreen;
