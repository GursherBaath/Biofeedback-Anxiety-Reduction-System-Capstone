import React, {useEffect, useState} from 'react';
import {View, StyleSheet} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import PPGMonitorScreen from './src/screens/PPGMonitorScreen';
import HRVScreen from './src/screens/HRVScreen';
import AmplitudeScreen from './src/screens/AmplitudeScreen';
import WelcomeScreen from './src/screens/WelcomeScreen';
import SessionHistoryScreen from './src/screens/SessionHistoryScreen';
import WeeklyInsightsScreen from './src/screens/WeeklyInsightsScreen';
import InstructionsScreen from './src/screens/InstructionsScreen';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {AppContextProvider, useAppContext} from './src/context/AppContext';

const Tab = createBottomTabNavigator();

type AppView = 'welcome' | 'session' | 'history' | 'insights' | 'developer' | 'instructions';

const TabNavigator: React.FC = () => (
  <NavigationContainer>
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0d0d1a',
          borderTopColor: '#1a1a2e',
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: '#00E676',
        tabBarInactiveTintColor: '#6666aa',
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
      }}>
      <Tab.Screen
        name="HRV Analysis"
        component={HRVScreen}
        options={{
          tabBarLabel: 'HRV Analysis',
          tabBarIcon: ({color, size}) => (
            <Icon name="chart-line" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Amplitude"
        component={AmplitudeScreen}
        options={{
          tabBarLabel: 'Amplitude',
          tabBarIcon: ({color, size}) => (
            <Icon name="waveform" color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  </NavigationContainer>
);

const AppInner: React.FC = () => {
  const [view, setView] = useState<AppView>('welcome');
  const {setExitSession, isDemoMode, setIsDemoMode} = useAppContext();

  useEffect(() => {
    setExitSession(() => setView('welcome'));
  }, [setExitSession]);

  if (view === 'session') {
    return (
      <View style={styles.root}>
        <TabNavigator />
      </View>
    );
  }

  if (view === 'history') {
    return (
      <View style={styles.root}>
        <SessionHistoryScreen
          onBack={() => setView('welcome')}
          onInsights={() => setView('insights')}
        />
      </View>
    );
  }

  if (view === 'insights') {
    return (
      <View style={styles.root}>
        <WeeklyInsightsScreen
          onBack={() => setView('history')}
        />
      </View>
    );
  }

  if (view === 'developer') {
    return (
      <View style={styles.root}>
        <PPGMonitorScreen onBack={() => setView('welcome')} />
      </View>
    );
  }

  if (view === 'instructions') {
    return (
      <View style={styles.root}>
        <InstructionsScreen onBack={() => setView('welcome')} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <WelcomeScreen
        onSessionStart={() => setView('session')}
        onSessionHistory={() => setView('history')}
        onDeveloperMode={() => setView('developer')}
        onDemoMode={() => setIsDemoMode(!isDemoMode)}
        onInstructions={() => setView('instructions')}
      />
    </View>
  );
};

const App: React.FC = () => (
  <AppContextProvider>
    <AppInner />
  </AppContextProvider>
);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0d0d1a',
  },
});

export default App;
