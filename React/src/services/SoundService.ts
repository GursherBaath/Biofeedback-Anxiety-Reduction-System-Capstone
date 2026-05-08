import Sound from 'react-native-sound';

// Enable playback in silent mode (iOS)
Sound.setCategory('Playback');

let greenSound: Sound | null = null;
let yellowSound: Sound | null = null;

function loadSounds() {
  if (!greenSound) {
    greenSound = new Sound('tone_green.wav', Sound.MAIN_BUNDLE, err => {
      if (err) {
        console.log('[Sound] Failed to load green tone:', err);
        greenSound = null;
      }
    });
  }
  if (!yellowSound) {
    yellowSound = new Sound('tone_yellow.wav', Sound.MAIN_BUNDLE, err => {
      if (err) {
        console.log('[Sound] Failed to load yellow tone:', err);
        yellowSound = null;
      }
    });
  }
}

export function initSounds() {
  loadSounds();
}

export function playFeedbackSound(color: string) {
  if (color === 'green' && greenSound) {
    greenSound.stop(() => {
      greenSound!.play();
    });
  } else if (color === 'yellow' && yellowSound) {
    yellowSound.stop(() => {
      yellowSound!.play();
    });
  }
  // red → no sound
}

export function releaseSounds() {
  greenSound?.release();
  yellowSound?.release();
  greenSound = null;
  yellowSound = null;
}
