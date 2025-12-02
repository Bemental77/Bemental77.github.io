import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useGameStore } from '@store/gameStore';

export const GameControls: React.FC = () => {
  const { movePlayer, togglePause, isPaused } = useGameStore();

  const handleMove = (dx: number, dy: number) => {
    movePlayer(dx, dy);
  };

  return (
    <View style={styles.container}>
      {/* D-Pad */}
      <View style={styles.dpad}>
        <View style={styles.dpadRow}>
          <TouchableOpacity
            style={styles.dpadButton}
            onPress={() => handleMove(0, -1)}
            disabled={isPaused}
          >
            <Text style={styles.buttonText}>↑</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dpadRow}>
          <TouchableOpacity
            style={styles.dpadButton}
            onPress={() => handleMove(-1, 0)}
            disabled={isPaused}
          >
            <Text style={styles.buttonText}>←</Text>
          </TouchableOpacity>
          <View style={styles.dpadCenter} />
          <TouchableOpacity
            style={styles.dpadButton}
            onPress={() => handleMove(1, 0)}
            disabled={isPaused}
          >
            <Text style={styles.buttonText}>→</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dpadRow}>
          <TouchableOpacity
            style={styles.dpadButton}
            onPress={() => handleMove(0, 1)}
            disabled={isPaused}
          >
            <Text style={styles.buttonText}>↓</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={[styles.actionButton, styles.pauseButton]}
          onPress={togglePause}
        >
          <Text style={styles.actionButtonText}>
            {isPaused ? 'Resume' : 'Pause'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 20,
  },
  dpad: {
    alignItems: 'center',
  },
  dpadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 4,
  },
  dpadButton: {
    width: 50,
    height: 50,
    borderRadius: 8,
    backgroundColor: '#2196F3',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 4,
  },
  dpadCenter: {
    width: 50,
    height: 50,
    marginHorizontal: 4,
  },
  buttonText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#4CAF50',
  },
  pauseButton: {
    backgroundColor: '#FF9800',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
