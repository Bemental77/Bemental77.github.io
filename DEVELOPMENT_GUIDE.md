# React Native Implementation Guide

This guide covers how to use the Chupacabra React Native project and develop features.

## 🎯 Getting Started

### Installation & Setup

```bash
# 1. Navigate to project
cd /path/to/chupacbra

# 2. Install all dependencies
npm install

# 3. For iOS development only (macOS)
npm run pods

# 4. Start the Metro bundler
npm start

# 5. In another terminal, run on your platform
npm run android    # Android
npm run ios        # iOS
```

## 🏗️ Project Architecture

### File Structure

```
src/
├── App.tsx                  # Root component
├── navigation/
│   └── RootNavigator.tsx   # Screen navigation setup
├── screens/                # Full-screen components
│   ├── HomeScreen.tsx
│   ├── GameScreen.tsx
│   ├── GameOverScreen.tsx
│   └── SettingsScreen.tsx
├── components/             # Reusable UI components
│   ├── GameBoard.tsx
│   ├── Player.tsx
│   └── GameControls.tsx
├── store/                  # Global state (Zustand)
│   └── gameStore.ts
├── types/                  # TypeScript interfaces
│   └── index.ts
├── utils/                  # Helper functions
└── assets/                 # Images, fonts, etc.
```

### State Management

All game state is managed in `src/store/gameStore.ts` using Zustand:

```typescript
import { useGameStore } from '@store/gameStore';

// In your component
const { player, score, movePlayer } = useGameStore();
```

### Navigation Flow

```
Home Screen
├── Play Game → Game Screen → Game Over Screen
└── Settings → Settings Screen
```

## 🎮 Development Workflow

### 1. Making Changes

Edit files in `src/` and Metro will automatically reload.

```bash
# Terminal 1: Start bundler
npm start

# Terminal 2: Run app
npm run android
# or
npm run ios
```

### 2. Adding a New Screen

Create `src/screens/MyScreen.tsx`:

```typescript
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '@types/index';

type Props = NativeStackScreenProps<RootStackParamList, 'MyScreen'>;

export const MyScreen: React.FC<Props> = ({ navigation }) => {
  return (
    <View style={styles.container}>
      <Text>My Screen</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

Add to types in `src/types/index.ts`:

```typescript
export type RootStackParamList = {
  Home: undefined;
  MyScreen: undefined;  // Add this
  // ... other screens
};
```

Add to navigation in `src/navigation/RootNavigator.tsx`:

```typescript
<Stack.Screen name="MyScreen" component={MyScreen} />
```

### 3. Adding a New Component

Create `src/components/MyComponent.tsx`:

```typescript
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface MyComponentProps {
  title: string;
}

export const MyComponent: React.FC<MyComponentProps> = ({ title }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
  },
});
```

### 4. Adding Game Logic

Edit `src/store/gameStore.ts`:

```typescript
export const useGameStore = create<GameStore>((set) => ({
  // ... existing state

  myNewAction: (param: string) =>
    set((state) => ({
      // Update state
      player: {
        ...state.player,
        customProp: param,
      },
    })),
}));
```

Use in components:

```typescript
const { myNewAction } = useGameStore();

// Call it
myNewAction('value');
```

## 📱 Platform-Specific Code

### Using Platform Detection

```typescript
import { Platform } from 'react-native';

if (Platform.OS === 'ios') {
  // iOS specific code
} else {
  // Android specific code
}
```

### Platform-Specific Files

Create separate files for platform-specific implementations:

```
MyComponent.tsx          # Shared component
MyComponent.ios.tsx      # iOS specific (auto-selected on iOS)
MyComponent.android.tsx  # Android specific (auto-selected on Android)
```

Then import normally:

```typescript
import { MyComponent } from '@components/MyComponent';  // Auto-selects based on platform
```

## 🎨 Styling

Use `StyleSheet` for better performance:

```typescript
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  text: {
    fontSize: 16,
    color: '#333',
  },
});
```

## 🧪 Testing

### Running Tests

```bash
npm test
```

### Writing Tests

Create test files next to components:

```typescript
// MyComponent.test.tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { MyComponent } from './MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    const { getByText } = render(<MyComponent title="Test" />);
    expect(getByText('Test')).toBeTruthy();
  });
});
```

## 🔄 Common Tasks

### Navigating Between Screens

```typescript
// From a screen component
const { navigation } = props;

// Push new screen
navigation.navigate('GameScreen');

// Go back
navigation.goBack();

// Replace current screen
navigation.replace('HomeScreen');

// Pop to top
navigation.popToTop();

// Pass parameters
navigation.navigate('GameOverScreen', { score: 100 });
```

### Accessing Navigation Parameters

```typescript
const { route } = props;
const { score } = route.params;
```

### Updating Global State

```typescript
const { movePlayer, updateScore } = useGameStore();

// Update state
movePlayer(1, 0);  // Move player right
updateScore(10);   // Add 10 points
```

### Debugging

```typescript
// Add console logging
console.log('Debug info:', someValue);

// Use React Native Debugger
// 1. Install: npm install -g react-native-debugger
// 2. Run: react-native-debugger
// 3. Shake device and select "Debug"

// Use Hermes debugger for iOS
// 1. Use Xcode debugger
// 2. Breakpoints work in source files
```

## 🚀 Building for Release

### Android Release Build

```bash
# Generate signed APK
npm run build:android

# APK location
# android/app/build/outputs/apk/release/app-release.apk
```

### iOS Release Build

```bash
# Generate IPA
npm run build:ios

# Then submit via App Store Connect or TestFlight
```

## 🐛 Common Issues & Solutions

### Problem: Metro bundler crashes

**Solution:**
```bash
npm start -- --reset-cache
```

### Problem: "Module not found" error

**Solution:**
```bash
rm -rf node_modules
npm install
npm start -- --reset-cache
```

### Problem: Android build fails

**Solution:**
```bash
cd android
./gradlew clean
cd ..
npm run android
```

### Problem: iOS build fails

**Solution:**
```bash
npm run clean
npm run pods
npm run ios
```

### Problem: "Cannot find variable" after changes

**Solution:**
1. Restart Metro bundler: Ctrl+C, then `npm start -- --reset-cache`
2. Reload app: Cmd+R (iOS) or R key (Android)

### Problem: Hot reload not working

**Solution:**
1. Make sure only one Metro bundler is running
2. Reload app manually
3. Restart both bundler and app

## 📚 Key Concepts

### Hooks

```typescript
import { useState, useEffect } from 'react';

export const MyComponent = () => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // Run when component mounts
    console.log('Component mounted');
    
    return () => {
      // Cleanup when component unmounts
    };
  }, []);  // Dependency array

  return <View />;
};
```

### Props vs State

```typescript
// Props: Read-only data passed from parent
interface Props {
  title: string;
}

// State: Component's own data that can change
const [count, setCount] = useState(0);
```

### Styling

```typescript
// Inline styles
<View style={{ flex: 1 }}>

// StyleSheet (preferred)
const styles = StyleSheet.create({
  container: { flex: 1 }
});
<View style={styles.container}>

// Conditional styles
<View style={[styles.base, isActive && styles.active]}>
```

## 📖 Learning Resources

- [React Native Documentation](https://reactnative.dev/docs/getting-started)
- [React Navigation Docs](https://reactnavigation.org/docs/getting-started)
- [Zustand Documentation](https://github.com/pmndrs/zustand)
- [React Hooks Guide](https://react.dev/reference/react)

## 🎓 Next Steps

1. **Understand the current code** - Read through existing screens and components
2. **Make small changes** - Edit text, colors, button labels
3. **Add a new component** - Create a simple UI component
4. **Add game logic** - Implement a new game feature
5. **Test on device** - Run on physical iPhone/Android
6. **Prepare for distribution** - Build release versions

---

**Happy coding! 🚀**
