import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  ImageBackground,
  ScrollView,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  loadSessions,
  loadDemoSessions,
  buildDemoSessions,
  deleteSession,
  deleteDemoSessionRecord,
  groupByWeek,
  formatDayLabel,
  formatTime,
  formatDuration,
  formatWeekLabel,
  Session,
} from '../services/SessionStorageService';
import {useAppContext} from '../context/AppContext';

interface Props {
  onBack: () => void;
  onInsights: () => void;
}

// ── Tiny sparkline chart built from plain Views ────────────────────────────
interface SparkPoint {
  label: string;
  value: number | null;
}

const CHART_H = 80;
const DOT_R = 5;

const SparkLine: React.FC<{points: SparkPoint[]; color: string; unit: string}> = ({
  points,
  color,
  unit,
}) => {
  const screenWidth = Dimensions.get('window').width;
  const YAXIS_W = 40;
  const CARD_PAD = 18;
  const chartW = screenWidth - 64 - YAXIS_W + CARD_PAD; // pull Y-axis to card left edge

  const valid = points.filter(p => p.value != null) as {label: string; value: number}[];
  if (valid.length < 2) {
    return (
      <View style={{height: CHART_H, justifyContent: 'center', alignItems: 'center'}}>
        <Text style={{color: '#ffffff', fontSize: 13}}>
          Need 2+ weeks of data
        </Text>
      </View>
    );
  }

  const values = valid.map(p => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const DOT_PAD = 16; // inset first/last dot from chart edges
  const toX = (i: number) =>
    valid.length === 1 ? chartW / 2 : DOT_PAD + (i / (valid.length - 1)) * (chartW - DOT_PAD * 2);
  const toY = (v: number) =>
    DOT_R + ((maxV - v) / range) * (CHART_H - DOT_R * 2);

  // Build connecting line segments
  const segments: {x1: number; y1: number; x2: number; y2: number}[] = [];
  for (let i = 0; i < valid.length - 1; i++) {
    segments.push({
      x1: toX(i),
      y1: toY(valid[i].value),
      x2: toX(i + 1),
      y2: toY(valid[i + 1].value),
    });
  }

  return (
    <View style={{flexDirection: 'row', alignItems: 'flex-start', marginLeft: -CARD_PAD}}>
      {/* Y-axis labels */}
      <View style={{width: YAXIS_W, height: CHART_H, justifyContent: 'space-between', alignItems: 'flex-end', paddingRight: 4}}>
        <Text style={{fontSize: 9, color: '#ffffff', fontWeight: '600'}}>
          {maxV % 1 === 0 ? maxV.toFixed(0) : maxV.toFixed(1)}
        </Text>
        <Text style={{fontSize: 9, color: '#ffffff', fontWeight: '600'}}>
          {((maxV + minV) / 2) % 1 === 0 ? ((maxV + minV) / 2).toFixed(0) : ((maxV + minV) / 2).toFixed(1)}
        </Text>
        <Text style={{fontSize: 9, color: '#ffffff', fontWeight: '600'}}>
          {minV % 1 === 0 ? minV.toFixed(0) : minV.toFixed(1)}
        </Text>
      </View>
      <View>
        <View style={{height: CHART_H, width: chartW, position: 'relative'}}>
          {/* Line segments */}
          {segments.map((seg, i) => {
            const dx = seg.x2 - seg.x1;
            const dy = seg.y2 - seg.y1;
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) * (180 / Math.PI);
            return (
              <View
                key={`seg-${i}`}
                style={{
                  position: 'absolute',
                  left: (seg.x1 + seg.x2) / 2 - length / 2,
                  top: (seg.y1 + seg.y2) / 2 - 1,
                  width: length,
                  height: 2,
                  backgroundColor: `${color}80`,
                  transform: [{rotate: `${angle}deg`}],
                }}
              />
            );
          })}
          {/* Dots + value labels */}
          {valid.map((p, i) => {
            const cx = toX(i);
            const cy = toY(p.value);
            const labelAbove = cy > 16;
            return (
              <React.Fragment key={`dot-${i}`}>
                <View
                  style={{
                    position: 'absolute',
                    left: cx - DOT_R,
                    top: cy - DOT_R,
                    width: DOT_R * 2,
                    height: DOT_R * 2,
                    borderRadius: DOT_R,
                    backgroundColor: color,
                  }}
                />
                <Text
                  style={{
                    position: 'absolute',
                    left: cx - 22,
                    top: labelAbove ? cy - DOT_R - 14 : cy + DOT_R + 2,
                    width: 44,
                    textAlign: 'center',
                    fontSize: 9,
                    color: `${color}cc`,
                    fontWeight: '700',
                  }}>
                  {p.value % 1 === 0 ? p.value.toFixed(0) : p.value.toFixed(1)}
                </Text>
              </React.Fragment>
            );
          })}
        </View>
        {/* X-axis labels */}
        <View style={{flexDirection: 'row', width: chartW, position: 'relative', height: 18}}>
          {valid.map((p, i) => (
            <Text
              key={`lbl-${i}`}
              style={{
                position: 'absolute',
                left: toX(i) - 22,
                width: 44,
                textAlign: 'center',
                fontSize: 10,
                color: '#ffffff',
              }}>
              {p.label}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
};
// ──────────────────────────────────────────────────────────────────────────

const SessionHistoryScreen: React.FC<Props> = ({onBack, onInsights}) => {
  const [weeks, setWeeks] = useState<{weekStart: Date; sessions: Session[]}[]>([]);
  const [weekIndex, setWeekIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
    setWeeks(groupByWeek(sessions));
    setLoading(false);
  }, [isDemoMode]);

  useEffect(() => {
    reload();
  }, [reload]);

  const currentWeek = weeks[weekIndex] ?? null;
  const totalWeeks = weeks.length;

  useEffect(() => {
    if (weekIndex > 0 && weekIndex >= totalWeeks) {
      setWeekIndex(totalWeeks - 1);
    }
  }, [totalWeeks, weekIndex]);

  // Build week-over-week sparkline data (oldest → newest)
  const longTermPoints = useMemo(() => {
    const sorted = [...weeks].reverse(); // oldest first
    const improvPoints: SparkPoint[] = [];
    const baselinePoints: SparkPoint[] = [];
    const amplitudePoints: SparkPoint[] = [];
    for (const w of sorted) {
      const label = formatWeekLabel(w.weekStart).replace(/\w+ /, '').replace(' - ', '-');
      const improvVals = w.sessions
        .filter(s => s.rmssdImprovementPct != null)
        .map(s => s.rmssdImprovementPct as number);
      const baselineVals = w.sessions
        .filter(s => s.baselineRmssd != null)
        .map(s => s.baselineRmssd as number);
      const ampVals = w.sessions
        .filter(s => s.meanAmplitude != null)
        .map(s => s.meanAmplitude as number);
      const avg = (arr: number[]) =>
        arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      improvPoints.push({label, value: avg(improvVals)});
      baselinePoints.push({label, value: avg(baselineVals)});
      amplitudePoints.push({label, value: avg(ampVals)});
    }
    return {improvPoints, baselinePoints, amplitudePoints};
  }, [weeks]);

  const handleDeleteSession = useCallback((session: Session) => {
    Alert.alert(
      'Delete session?',
      'This session will be permanently removed from history.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(session.id);
            if (isDemoMode) {
              await deleteDemoSessionRecord(session.id);
            } else {
              await deleteSession(session.id);
            }
            await reload();
            setDeletingId(null);
          },
        },
      ],
    );
  }, [reload]);

  const buildRows = () => {
    if (!currentWeek) return [];
    const rows: {session: Session; dayLabel: string; time: string; duration: string; detail: string}[] = [];
    let lastDay = '';
    for (const s of currentWeek.sessions) {
      const dayLabel = formatDayLabel(s.startTime);
      let detail = '';
      if (s.type === 'amplitude' && s.meanAmplitude != null) {
        detail = `Amp ${s.meanAmplitude.toFixed(1)}`;
      } else if (s.rmssdImprovementPct != null) {
        detail = `${s.rmssdImprovementPct >= 0 ? '+' : ''}${s.rmssdImprovementPct.toFixed(1)}%`;
      }
      rows.push({
        session: s,
        dayLabel: dayLabel !== lastDay ? dayLabel : '',
        time: formatTime(s.startTime),
        duration: formatDuration(s.durSeconds),
        detail,
      });
      lastDay = dayLabel;
    }
    return rows;
  };

  const rows = buildRows();

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
        <Text style={styles.headerTitle}>Session History</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* This Week's Feedback */}
        <TouchableOpacity
          style={styles.feedbackCard}
          onPress={onInsights}
          activeOpacity={0.85}>
          <Text style={styles.feedbackText}>This Week's Feedback</Text>
          <Icon name="arrow-right" size={28} color="#ffffff" />
        </TouchableOpacity>

        {/* Long Term Tracking */}
        {totalWeeks >= 1 && (
          <View style={styles.trackingCard}>
            <Text style={styles.trackingTitle}>LONG TERM TRACKING</Text>
            <Text style={styles.trackingSubtitle}>Week-over-week averages</Text>

            <Text style={styles.trackingMetricLabel}>Session Improvement (%)</Text>
            <SparkLine
              points={longTermPoints.improvPoints}
              color="#00E676"
              unit="%"
            />

            <View style={styles.trackingDivider} />

            <Text style={styles.trackingMetricLabel}>Baseline RMSSD (ms)</Text>
            <SparkLine
              points={longTermPoints.baselinePoints}
              color="#c0b0ff"
              unit=" ms"
            />

            <View style={styles.trackingDivider} />

            <Text style={styles.trackingMetricLabel}>Mean RSA Amplitude (bpm)</Text>
            <SparkLine
              points={longTermPoints.amplitudePoints}
              color="#448AFF"
              unit=" bpm"
            />
          </View>
        )}

        {/* Week Table */}
        <View style={styles.tableCard}>
          <View style={styles.weekNav}>
            <TouchableOpacity
              onPress={() => setWeekIndex(i => Math.min(i + 1, totalWeeks - 1))}
              disabled={weekIndex >= totalWeeks - 1}
              activeOpacity={0.7}
              style={[styles.navBtn, weekIndex >= totalWeeks - 1 && styles.navBtnDisabled]}>
              <Icon name="arrow-left" size={22} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.weekLabel}>
              {currentWeek ? formatWeekLabel(currentWeek.weekStart) : 'No Sessions'}
            </Text>
            <TouchableOpacity
              onPress={() => setWeekIndex(i => Math.max(i - 1, 0))}
              disabled={weekIndex <= 0}
              activeOpacity={0.7}
              style={[styles.navBtn, weekIndex <= 0 && styles.navBtnDisabled]}>
              <Icon name="arrow-right" size={22} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator color="#c0b0ff" size="large" style={styles.loader} />
          ) : rows.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Icon name="calendar-blank" size={48} color="rgba(180,160,255,0.4)" />
              <Text style={styles.emptyText}>No sessions this week</Text>
              <Text style={styles.emptySubText}>Complete a recording to see it here</Text>
            </View>
          ) : (
            <View style={styles.table}>
              {rows.map((row, i) => (
                <View
                  key={row.session.id}
                  style={[styles.tableRow, i % 2 === 0 ? styles.rowEven : styles.rowOdd]}>
                  <Text style={[styles.cell, styles.cellDay]}>{row.dayLabel}</Text>
                  <Text style={[styles.cell, styles.cellTime]}>{row.time}</Text>
                  <Text style={[styles.cell, styles.cellDur]}>{row.duration}</Text>
                  <Text style={[styles.cell, styles.cellDetail,
                    row.session.type === 'amplitude' ? {color: '#ffffff'} : {color: '#ffffff'},
                  ]}>{row.detail}</Text>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDeleteSession(row.session)}
                    activeOpacity={0.7}
                    disabled={deletingId === row.session.id}>
                    <Icon
                      name="trash-can-outline"
                      size={18}
                      color={deletingId === row.session.id ? 'rgba(255,120,120,0.45)' : '#ff9090'}
                    />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {totalWeeks > 0 && (
        <View style={styles.pagination}>
          <TouchableOpacity
            onPress={() => setWeekIndex(i => Math.min(i + 1, totalWeeks - 1))}
            disabled={weekIndex >= totalWeeks - 1}
            activeOpacity={0.7}>
            <Icon
              name="chevron-left"
              size={22}
              color={weekIndex >= totalWeeks - 1 ? 'rgba(255,255,255,0.3)' : '#ffffff'}
            />
          </TouchableOpacity>
          <Text style={styles.pageText}>{weekIndex + 1} / {totalWeeks}</Text>
          <TouchableOpacity
            onPress={() => setWeekIndex(i => Math.max(i - 1, 0))}
            disabled={weekIndex <= 0}
            activeOpacity={0.7}>
            <Icon
              name="chevron-right"
              size={22}
              color={weekIndex <= 0 ? 'rgba(255,255,255,0.3)' : '#ffffff'}
            />
          </TouchableOpacity>
        </View>
      )}
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
  scroll: {flex: 1},
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 80,
    gap: 16,
  },
  feedbackCard: {
    backgroundColor: 'rgba(100, 70, 200, 0.75)',
    borderRadius: 16,
    paddingVertical: 22,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.3)',
  },
  feedbackText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  trackingCard: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
  },
  trackingTitle: {
    fontSize: 12,
    color: '#ffffff',
    letterSpacing: 0.8,
    fontWeight: '700',
    marginBottom: 2,
  },
  trackingSubtitle: {
    fontSize: 11,
    color: '#ffffff',
    marginBottom: 14,
  },
  trackingMetricLabel: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
    marginBottom: 6,
  },
  trackingDivider: {
    height: 1,
    backgroundColor: 'rgba(180, 150, 255, 0.2)',
    marginVertical: 14,
  },
  tableCard: {
    backgroundColor: 'rgba(80, 55, 160, 0.65)',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.25)',
    paddingBottom: 8,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(180, 150, 255, 0.2)',
  },
  navBtn: {padding: 4},
  navBtnDisabled: {opacity: 0.3},
  weekLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  loader: {margin: 32},
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 36,
    gap: 10,
  },
  emptyText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
  },
  emptySubText: {
    fontSize: 13,
    color: '#ffffff',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  table: {overflow: 'hidden'},
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(160, 130, 255, 0.2)',
  },
  rowEven: {backgroundColor: 'rgba(230, 220, 255, 0.12)'},
  rowOdd: {backgroundColor: 'rgba(200, 185, 255, 0.06)'},
  cell: {fontSize: 16, color: '#ffffff', fontWeight: '600'},
  cellDay: {flex: 1.2},
  cellTime: {flex: 1, textAlign: 'center'},
  cellDur: {flex: 0.8, textAlign: 'right'},
  cellDetail: {flex: 0.8, textAlign: 'right', fontSize: 13, fontWeight: '700'},
  deleteBtn: {
    marginLeft: 10,
    paddingHorizontal: 4,
    paddingVertical: 2,
    alignSelf: 'center',
  },
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    paddingVertical: 14,
    backgroundColor: 'rgba(20, 10, 50, 0.7)',
  },
  pageText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    minWidth: 50,
    textAlign: 'center',
  },
});

export default SessionHistoryScreen;
