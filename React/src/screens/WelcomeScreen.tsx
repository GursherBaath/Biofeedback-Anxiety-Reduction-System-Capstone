import React, {useState, useCallback, useEffect} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  ImageBackground,
  ActivityIndicator,
  Alert,
  Image,
} from 'react-native';
import {bleService} from '../services/BleService';
import {useAppContext} from '../context/AppContext';

interface Props {
  onSessionStart: () => void;
  onSessionHistory: () => void;
  onDeveloperMode: () => void;
  onDemoMode: () => void;
  onInstructions: () => void;
}

const WelcomeScreen: React.FC<Props> = ({onSessionStart, onSessionHistory, onDeveloperMode, onDemoMode, onInstructions}) => {
  const {isDemoMode} = useAppContext();
  const [isConnected, setIsConnected] = useState(bleService.connected);
  const [isConnecting, setIsConnecting] = useState(false);

  // Stay in sync if BLE connects/disconnects while this screen is mounted
  useEffect(() => {
    bleService.addOnStatusChange('welcome', (status: string) => {
      setIsConnected(status.includes('Streaming'));
    });
    return () => {
      bleService.removeOnStatusChange('welcome');
    };
  }, []);

  const handleConnect = useCallback(async () => {
    if (isConnected) return;
    setIsConnecting(true);
    try {
      await bleService.scanAndConnect();
      setIsConnected(true);
    } catch (e: any) {
      Alert.alert('Connection Failed', e.message ?? 'Could not connect to device.');
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, [isConnected]);

  return (
    <ImageBackground
      source={require('../assets/images/background.jpg')}
      style={styles.bg}
      resizeMode="cover">
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <View style={styles.overlay} />

      {/* Demo mode — subtle tap target in top-right corner */}
      <TouchableOpacity
        style={styles.demoButton}
        onPress={onDemoMode}
        activeOpacity={0.6}>
        <Text style={[styles.demoButtonText, isDemoMode && styles.demoButtonTextActive]}>Demo</Text>
      </TouchableOpacity>

      <View style={styles.content}>
        <View style={styles.titleContainer}>
          <Image
            source={require('../assets/images/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        <View style={styles.buttons}>
          {/* Connect Device */}
          <TouchableOpacity
            style={[
              styles.button,
              isConnected && styles.buttonDimmed,
              isConnecting && styles.buttonDimmed,
            ]}
            onPress={handleConnect}
            disabled={isConnected || isConnecting}
            activeOpacity={0.8}>
            {isConnecting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.buttonText}>
                {isConnected ? 'Device Connected' : 'Connect Device'}
              </Text>
            )}
          </TouchableOpacity>

          {/* Start a Session */}
          <TouchableOpacity
            style={[styles.button, !isConnected && styles.buttonDisabled]}
            onPress={onSessionStart}
            disabled={!isConnected}
            activeOpacity={0.8}>
            <Text style={[styles.buttonText, !isConnected && styles.buttonTextDisabled]}>
              Start a Session
            </Text>
          </TouchableOpacity>

          {/* Session History */}
          <TouchableOpacity
            style={styles.button}
            onPress={onSessionHistory}
            activeOpacity={0.8}>
            <Text style={styles.buttonText}>Session History</Text>
          </TouchableOpacity>

          {/* Instructions */}
          <TouchableOpacity
            style={styles.button}
            onPress={onInstructions}
            activeOpacity={0.8}>
            <Text style={styles.buttonText}>Instructions</Text>
          </TouchableOpacity>
        </View>

        {/* Developer mode — subtle link at bottom */}
        <TouchableOpacity
          style={styles.devButton}
          onPress={onDeveloperMode}
          activeOpacity={0.6}>
          <Text style={styles.devButtonText}>Developer Mode</Text>
        </TouchableOpacity>
      </View>
    </ImageBackground>
  );
};

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingBottom: 60,
    paddingHorizontal: 32,
  },
  titleContainer: {
    marginTop: '30%',
    alignItems: 'center',
  },
  logo: {
    width: 280,
    height: 180,
  },
  buttons: {
    gap: 14,
  },
  button: {
    backgroundColor: 'rgba(30, 60, 120, 0.85)',
    borderRadius: 10,
    paddingVertical: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(100, 150, 255, 0.3)',
  },
  buttonDimmed: {
    backgroundColor: 'rgba(30, 60, 120, 0.4)',
    borderColor: 'rgba(100, 150, 255, 0.15)',
  },
  buttonDisabled: {
    backgroundColor: 'rgba(30, 60, 120, 0.4)',
    borderColor: 'rgba(100, 150, 255, 0.15)',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  buttonTextDisabled: {
    color: 'rgba(200,200,200,0.45)',
  },
  devButton: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  devButtonText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  demoButton: {
    position: 'absolute',
    top: 52,
    right: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  demoButtonText: {
    color: 'rgba(255,255,255,0.22)',
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.4,
  },
  demoButtonTextActive: {
    color: 'rgba(255,255,255,1)',
  },
});

export default WelcomeScreen;
