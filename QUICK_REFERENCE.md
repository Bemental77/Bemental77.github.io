# React Native Quick Reference

## 📋 Installation

```bash
npm install                # Install dependencies
npm run pods              # iOS only - install CocoaPods
```

## 🚀 Running the App

```bash
npm start                 # Start Metro bundler
npm run android           # Run on Android (terminal 2)
npm run ios              # Run on iOS (terminal 2, macOS only)
```

## 📁 Key Files to Know

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component |
| `src/navigation/RootNavigator.tsx` | Screen navigation |
| `src/store/gameStore.ts` | Game state (Zustand) |
| `src/types/index.ts` | TypeScript types |
| `package.json` | Dependencies & scripts |
| `app.json` | App configuration |

## 🎨 Common Components

### View (Container)
```typescript
<View style={styles.container}>
  {/* Child elements */}
</View>
```

### Text
```typescript
<Text style={styles.title}>Hello World</Text>
```

### TouchableOpacity (Button)
```typescript
<TouchableOpacity onPress={() => console.log('Pressed!')}>
  <Text>Press Me</Text>
</TouchableOpacity>
```

### StyleSheet
```typescript
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
```

## 🎮 Game State Usage

```typescript
import { useGameStore } from '@store/gameStore';

// In your component
const { player, score, movePlayer } = useGameStore();
```

## 🧭 Navigation

```typescript
// Navigate to screen
navigation.navigate('GameScreen');

// Go back
navigation.goBack();

// With parameters
navigation.navigate('GameOverScreen', { score: 100 });

// Access parameters
const { score } = route.params;
```

## 🔧 Hot Reload

- **iOS**: Press Cmd+R in simulator
- **Android**: Press R key (twice for full reload)
- **Manual restart**: `npm start -- --reset-cache`

## 🐛 Debugging

```typescript
// Console logging
console.log('Value:', myVar);
console.warn('Warning:', problem);
console.error('Error:', error);

// Inspect props/state
console.log('Props:', props);
console.log('State:', { player, score });
```

## 📦 Build Commands

```bash
npm test                 # Run tests
npm run lint            # Check code style
npm run type-check      # Check TypeScript
npm run build:android   # Build Android APK
npm run build:ios      # Build iOS IPA
npm run clean          # Clean install
```

## ⚡ Performance Tips

1. Use `React.memo` for components that don't need frequent updates
2. Use `useMemo` for expensive computations
3. Use `useCallback` for stable function references
4. Avoid inline function definitions in event handlers
5. Use `FlatList` for long lists instead of ScrollView

## 🎯 Project Structure

```
chupacbra/
├── src/
│   ├── screens/        ← Full page components
│   ├── components/     ← Reusable UI components
│   ├── navigation/     ← Navigation setup
│   ├── store/         ← Global state
│   ├── types/         ← TypeScript definitions
│   └── App.tsx        ← Root component
├── android/           ← Android native code
├── ios/              ← iOS native code
└── package.json      ← Dependencies
```

## 🌐 Platform Differences

```typescript
import { Platform } from 'react-native';

// Check platform
if (Platform.OS === 'ios') {
  // iOS specific
} else if (Platform.OS === 'android') {
  // Android specific
}

// Platform-specific files
MyComponent.ios.tsx    // Used on iOS
MyComponent.android.tsx // Used on Android
```

## 💾 Local Storage

```typescript
import { AsyncStorage } from '@react-native-async-storage/async-storage';

// Save
await AsyncStorage.setItem('key', JSON.stringify(value));

// Load
const value = JSON.parse(await AsyncStorage.getItem('key') || '{}');

// Remove
await AsyncStorage.removeItem('key');
```

## 🎬 Common Patterns

### Conditional Rendering
```typescript
{isLoggedIn ? <Home /> : <Login />}
{isLoading && <Spinner />}
```

### List Rendering
```typescript
{items.map((item) => (
  <Item key={item.id} {...item} />
))}
```

### Event Handling
```typescript
<TouchableOpacity onPress={handlePress}>
  <TextInput onChange={handleChange} />
</TouchableOpacity>
```

## 🔗 Useful Commands

```bash
npm start              # Start bundler
npm run android        # Run on Android
npm run ios           # Run on iOS
npm test              # Run tests
npm run lint          # Lint code
npm run pods          # Install iOS pods
npm run clean         # Fresh install
```

## 📞 Getting Help

- Check `REACT_NATIVE_SETUP.md` for detailed setup
- See `DEVELOPMENT_GUIDE.md` for advanced topics
- Visit [React Native Docs](https://reactnative.dev/)
- Check [React Navigation Docs](https://reactnavigation.org/)

---

**Pro Tip**: Use VS Code with React Native Tools extension for better development experience!
