import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '@types/index';
import { HomeScreen } from '@screens/HomeScreen';
import { GameScreen } from '@screens/GameScreen';
import { GameOverScreen } from '@screens/GameOverScreen';
import { SettingsScreen } from '@screens/SettingsScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const RootNavigator: React.FC = () => {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {
            backgroundColor: '#333',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
            fontSize: 18,
          },
          headerBackTitleVisible: false,
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="Game"
          component={GameScreen}
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="GameOver"
          component={GameOverScreen}
          options={{
            headerTitle: 'Game Over',
            headerLeft: () => null,
          }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            headerTitle: 'Settings',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};
