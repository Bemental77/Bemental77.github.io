# Chupacabra Maze - React Native Cross-Platform App

A modern cross-platform mobile game built with React Native, supporting both iOS and Android from a single codebase.

## 🎮 Features

- ✅ Cross-platform support (iOS & Android)
- ✅ TypeScript for type safety
- ✅ React Navigation for seamless navigation
- ✅ State management with Zustand
- ✅ Responsive UI with proper styling
- ✅ Game controls and maze rendering
- ✅ Score tracking and game over screen

## 📋 Prerequisites

- **Node.js** v16+ and npm v8+
- **React Native CLI**: `npm install -g react-native-cli`
- **Android Studio** (for Android development)
- **Xcode 15+** (for iOS development)
- **Java Development Kit (JDK)** 11+

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd /path/to/chupacbra
npm install
```

### 2. Install iOS Pods (macOS only)

```bash
npm run pods
```

### 3. Start Metro Bundler

```bash
npm start
```

The Metro bundler will start in the terminal.

### 4. Run on Android

In a new terminal:

```bash
npm run android
```

Or use Android Studio:
1. Open `android/` folder in Android Studio
2. Select device/emulator
3. Click "Run"

### 5. Run on iOS

In a new terminal (macOS only):

```bash
npm run ios
```

Or use Xcode:
1. Open `ios/Chupacabra.xcworkspace` in Xcode
2. Select device/simulator
3. Press Cmd+R to run

## 📁 Project Structure

```
chupacbra/
├── src/
│   ├── App.tsx                 # Main app component
│   ├── navigation/             # Navigation setup
│   │   └── RootNavigator.tsx   # Navigation configuration
│   ├── screens/                # Screen components
│   │   ├── HomeScreen.tsx
│   │   ├── GameScreen.tsx
│   │   ├── GameOverScreen.tsx
│   │   └── SettingsScreen.tsx
│   ├── components/             # Reusable components
│   │   ├── GameBoard.tsx
│   │   ├── Player.tsx
│   │   └── GameControls.tsx
│   ├── store/                  # State management (Zustand)
│   │   └── gameStore.ts
│   ├── types/                  # TypeScript type definitions
│   │   └── index.ts
│   ├── utils/                  # Utility functions
│   └── assets/                 # Images, fonts, etc.
├── android/                    # Android native code
├── ios/                        # iOS native code
├── index.ts                    # App entry point
├── app.json                    # App configuration
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript configuration
├── .babelrc                    # Babel configuration
├── .eslintrc.json              # ESLint rules
└── .prettierrc.json            # Code formatting rules
```

## 🎯 Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start Metro bundler |
| `npm run android` | Run app on Android |
| `npm run ios` | Run app on iOS |
| `npm run start:ios` | Start bundler for iOS |
| `npm run start:android` | Start bundler for Android |
| `npm test` | Run unit tests |
| `npm run lint` | Run ESLint |
| `npm run type-check` | Check TypeScript types |
| `npm run build:android` | Build Android release APK |
| `npm run build:ios` | Build iOS release app |
| `npm run pods` | Install iOS CocoaPods |
| `npm run clean` | Clean install everything |

## 🏗️ Architecture

### State Management (Zustand)

The app uses Zustand for global state management. The main store is `gameStore.ts`:

```typescript
const { player, isGameOver, movePlayer, resetGame } = useGameStore();
```

### Navigation

React Navigation is used for screen transitions:
- Stack Navigator for main flow
- Support for future Tab Navigator

### Components

- **Functional components** with hooks
- **TypeScript** for type safety
- **React.memo** for performance optimization

## 🎮 Game Flow

1. **Home Screen** → Start game or access settings
2. **Game Screen** → Play the maze game with directional controls
3. **Game Over Screen** → View score and retry or return home
4. **Settings Screen** → Configure game options

## 🔧 Development

### Adding a New Screen

1. Create file in `src/screens/YourScreen.tsx`
2. Add to navigation in `src/navigation/RootNavigator.tsx`
3. Update types in `src/types/index.ts`

### Adding a New Component

1. Create file in `src/components/YourComponent.tsx`
2. Export from component and import in screens
3. Style with StyleSheet

### Updating Game Logic

Edit `src/store/gameStore.ts` to add new game mechanics or state.

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm test -- --watch
```

## 🔍 Debugging

### Android
- Use Android Studio debugger
- Use `react-native log-android` to view logs
- React Native Debugger for app debugging

### iOS
- Use Xcode debugger
- Use Safari Web Inspector for JavaScript debugging
- React Native Debugger for app debugging

## 📦 Building for Distribution

### Android Release Build

```bash
npm run build:android
# APK location: android/app/build/outputs/apk/release/
```

### iOS Release Build

```bash
npm run build:ios
# Configure signing in Xcode before building
```

## 🐛 Troubleshooting

### Metro Bundler Won't Start
```bash
npm start -- --reset-cache
```

### Android Build Fails
```bash
cd android && ./gradlew clean && cd ..
npm run android
```

### iOS Build Fails
```bash
npm run clean
npm run pods
npm run ios
```

### Module Not Found Error
```bash
npm install
npm run pods  # iOS only
npm start -- --reset-cache
```

### Port 8081 Already in Use
```bash
# Kill process on port 8081
lsof -i :8081 | grep LISTEN | awk '{print $2}' | xargs kill -9
npm start
```

## 📱 Platform-Specific Code

Use platform-specific extensions:

```typescript
// For platform-specific implementations
import MyComponent from './MyComponent.ios';  // iOS
import MyComponent from './MyComponent.android';  // Android
```

Or use `Platform` API:

```typescript
import { Platform } from 'react-native';

if (Platform.OS === 'ios') {
  // iOS specific code
} else if (Platform.OS === 'android') {
  // Android specific code
}
```

## 📚 Dependencies

### Main Dependencies
- **react** - UI library
- **react-native** - Mobile framework
- **@react-navigation/native** - Navigation framework
- **zustand** - State management
- **typescript** - Type checking

### Development Dependencies
- **@babel/core** - JavaScript compiler
- **@typescript-eslint/** - TypeScript linting
- **jest** - Testing framework
- **prettier** - Code formatter

## 🔗 Useful Links

- [React Native Documentation](https://reactnative.dev/)
- [React Navigation Docs](https://reactnavigation.org/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Zustand Documentation](https://github.com/pmndrs/zustand)

## 📝 Development Notes

- The app uses TypeScript for better development experience
- All screens are typed with proper navigation parameters
- Zustand provides simple, scalable state management
- Code is formatted with Prettier
- Linting is done with ESLint

## 🎓 Next Steps

1. Migrate game logic from Java/C++ files to `src/` directory
2. Add more game features and levels
3. Implement persistent storage for scores
4. Add sound and music
5. Create native modules for advanced features
6. Set up CI/CD for automated builds
7. Prepare for app store submission

## 📄 License

Your license here

---

**Built with ❤️ using React Native**
