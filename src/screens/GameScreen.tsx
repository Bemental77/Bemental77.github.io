import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '@types/index';
import { useGameStore } from '@store/gameStore';
import { GameBoard } from '@components/GameBoard';
import { GameControls } from '@components/GameControls';

type Props = NativeStackScreenProps<RootStackParamList, 'Game'>;

export const GameScreen: React.FC<Props> = ({ navigation }) => {
  const { player, isPaused, isGameOver, resetGame } = useGameStore();

  useEffect(() => {
    resetGame();
  }, [resetGame]);

  useEffect(() => {
    if (isGameOver) {
      navigation.replace('GameOver', { score: player.score });
    }
  }, [isGameOver, navigation, player.score]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Level 1</Text>
        <Text style={styles.score}>Score: {player.score}</Text>
        <View style={styles.position}>
          <Text style={styles.positionText}>
            Position: ({player.x}, {player.y})
          </Text>
        </View>
      </View>

      <View style={styles.gameArea}>
        <GameBoard />
      </View>

      {isPaused && (
        <View style={styles.pauseOverlay}>
          <Text style={styles.pauseText}>PAUSED</Text>
        </View>
      )}

      <GameControls />

      <TouchableOpacity
        style={styles.homeButton}
        onPress={() => navigation.popToTop()}
      >
        <Text style={styles.homeButtonText}>← Back to Home</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#333',
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  score: {
    fontSize: 18,
    color: '#4CAF50',
    marginTop: 5,
    fontWeight: '600',
  },
  position: {
    marginTop: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  positionText: {
    fontSize: 12,
    color: '#fff',
  },
  gameArea: {
    padding: 20,
    alignItems: 'center',
  },
  pauseOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -50 }, { translateY: -50 }],
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingHorizontal: 40,
    paddingVertical: 20,
    borderRadius: 12,
  },
  pauseText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
  },
  homeButton: {
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#2196F3',
    alignItems: 'center',
  },
  homeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
