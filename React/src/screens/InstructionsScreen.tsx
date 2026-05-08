import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  ImageBackground,
  ScrollView,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

interface Props {
  onBack: () => void;
}

interface Section {
  title: string;
  icon: string;
  color: string;
  paragraphs: string[];
}

const SECTIONS: Section[] = [
  {
    title: 'General Instructions',
    icon: 'information-outline',
    color: '#B4A0FF',
    paragraphs: [
      'CalmCoach provides calm through two features. Breathing is important for both. Try slow comfortable breathing with exhales longer than inhales. Imagine you are breathing into your abdomen, a few inches below your navel. This will help you breathe in a more relaxed way. Your goal is to continuously receive green feedback throughout the exercises.',
    ],
  },
  {
    title: 'Vagus Nerve Activity HRV',
    icon: 'heart-pulse',
    color: '#00E676',
    paragraphs: [
      'The vagus nerve connects the brain and the heart and is an important part of the calming and restful parasympathetic nervous system. By taking the Root Mean Square of Successive Differences (RMSSD) of the time between heart beats, vagus nerve activity can be measured and evaluated. A higher RMSSD indicates more vagus nerve activity, showing that your body is starting to relax.',
      'Vagus nerve activity via the RMSSD will be measured every 10 seconds. Red coloured feedback means the RMSSD is significantly less than the previous measurement, yellow means only slightly less than the previous and green means higher or the same. Aim to increase your RMSSD throughout your session. This feature can be used with various calming exercises such as meditation.',
    ],
  },
  {
    title: 'RSA Amplitude',
    icon: 'waveform',
    color: '#82b1ff',
    paragraphs: [
      'When you breathe, your heart rate changes in a predictable way. During inhalation, your heart rate increases and during exhalation your heart rate decreases. This phenomenon is known as Respiratory Sinus Arrhythmia (RSA).',
      'During paced breathing, the heart rate graph resembles a wave and the height of this wave is the RSA amplitude. Maximizing the RSA amplitude leads to efficient breathing and promotes calm.',
      'There are two ways you can try to increase your RSA amplitude:\n\nOption 1: Using the heart rate display, aim to synchronise your breathing to the heart rate graph, by inhaling when the heart rate increases and exhaling when the heart rate decreases.\n\nOption 2: Simply perform paced breathing without actively attempting to synchronise with the heart rate graph.',
      'Regardless of the approach you chose, feedback will be provided on your RSA amplitude. Green indicates the amplitude is larger or equal to the previous measured amplitude, yellow indicates the amplitude is only slightly smaller, and significantly smaller is indicated by red. Sound feedback is provided through a pleasant tone for green, a neutral tone for yellow and no sound for red.',
      'With practice, you may notice a breathing rate that consistently maximizes your RSA amplitude. This is your "resonant frequency", and knowing it allows you to simply breathe at this frequency to maximize calm without the need for feedback. Most people\'s resonant frequency is between 5 and 6 breaths per minute.',
    ],
  },
];

const InstructionsScreen: React.FC<Props> = ({onBack}) => {
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
        <Text style={styles.headerTitle}>Instructions</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>
        {SECTIONS.map(section => (
          <View key={section.title} style={styles.card}>
            {/* Section heading */}
            <View style={styles.cardHeader}>
              <View style={[styles.iconBadge, {backgroundColor: `${section.color}22`}]}>
                <Icon name={section.icon} size={22} color={section.color} />
              </View>
              <Text style={[styles.cardTitle, {color: section.color}]}>{section.title}</Text>
            </View>

            <View style={[styles.divider, {backgroundColor: `${section.color}33`}]} />

            {section.paragraphs.map((para, i) => (
              <Text key={i} style={styles.bodyText}>
                {para}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </ImageBackground>
  );
};

const styles = StyleSheet.create({
  bg: {flex: 1, width: '100%', height: '100%'},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,5,30,0.55)',
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
    paddingBottom: 48,
    gap: 16,
  },
  card: {
    backgroundColor: 'rgba(80, 55, 160, 0.55)',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(180, 150, 255, 0.2)',
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  divider: {
    height: 1,
    borderRadius: 1,
    marginBottom: 4,
  },
  bodyText: {
    fontSize: 14,
    color: 'rgba(220, 205, 255, 0.88)',
    lineHeight: 22,
  },
});

export default InstructionsScreen;
