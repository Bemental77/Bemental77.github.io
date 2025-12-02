import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '@types/index';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export const HomeScreen: React.FC<Props> = ({ navigation }) => {
  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>🦙 Chupacabra Maze</Text>
        <Text style={styles.subtitle}>Navigate the legendary maze</Text>

        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>How to Play</Text>
          <Text style={styles.infoText}>
            • Use arrow buttons to move through the maze{'\n'}
            • Collect all items to complete the level{'\n'}
            • Avoid enemies and obstacles{'\n'}
            • Complete levels to unlock harder challenges
          </Text>
        </View>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, styles.playButton]}
            onPress={() => navigation.navigate('Game')}
          >
            <Text style={styles.buttonText}>Play Game</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.leaderboardButton]}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.buttonText}>Settings</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statsBox}>
          <Text style={styles.statsTitle}>Game Stats</Text>
          <Text style={styles.statsText}>High Score: Coming Soon</Text>
          <Text style={styles.statsText}>Levels Completed: 0</Text>
          <Text style={styles.statsText}>Total Play Time: 0h</Text>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'center',
    marginVertical: 20,
    color: '#333',
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    color: '#666',
    marginBottom: 30,
  },
  infoBox: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 10,
    color: '#333',
  },
  infoText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#666',
  },
  buttonContainer: {
    gap: 12,
    marginVertical: 20,
  },
  button: {
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  playButton: {
    backgroundColor: '#4CAF50',
  },
  leaderboardButton: {
    backgroundColor: '#2196F3',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  statsBox: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginTop: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statsTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 10,
    color: '#333',
  },
  statsText: {
    fontSize: 14,
    color: '#666',
    marginVertical: 4,
  },
});
