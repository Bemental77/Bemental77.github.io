import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '@types/index';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export const SettingsScreen: React.FC<Props> = ({ navigation }) => {
  const [musicEnabled, setMusicEnabled] = React.useState(true);
  const [soundEnabled, setSoundEnabled] = React.useState(true);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Audio</Text>

          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setMusicEnabled(!musicEnabled)}
          >
            <Text style={styles.settingLabel}>Music</Text>
            <Text style={styles.settingValue}>
              {musicEnabled ? '🔊 On' : '🔇 Off'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setSoundEnabled(!soundEnabled)}
          >
            <Text style={styles.settingLabel}>Sound Effects</Text>
            <Text style={styles.settingValue}>
              {soundEnabled ? '🔊 On' : '🔇 Off'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Game</Text>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Difficulty</Text>
            <Text style={styles.settingValue}>Normal</Text>
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Animations</Text>
            <Text style={styles.settingValue}>Enabled</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>

          <View style={styles.infoBox}>
            <Text style={styles.infoItem}>
              <Text style={styles.bold}>App Name:</Text> Chupacabra Maze
            </Text>
            <Text style={styles.infoItem}>
              <Text style={styles.bold}>Version:</Text> 1.0.0
            </Text>
            <Text style={styles.infoItem}>
              <Text style={styles.bold}>Platform:</Text> Cross-Platform (iOS &
              Android)
            </Text>
            <Text style={styles.infoItem}>
              <Text style={styles.bold}>Built with:</Text> React Native
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
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
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 24,
    color: '#333',
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#333',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  settingLabel: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
  },
  settingValue: {
    fontSize: 14,
    color: '#666',
  },
  infoBox: {
    padding: 16,
    backgroundColor: '#f9f9f9',
  },
  infoItem: {
    fontSize: 13,
    color: '#666',
    marginVertical: 6,
    lineHeight: 20,
  },
  bold: {
    fontWeight: '600',
    color: '#333',
  },
  backButton: {
    marginTop: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#2196F3',
    alignItems: 'center',
    marginBottom: 20,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
