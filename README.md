# 🦙 Chupacabra Maze - React Native

A legendary cross-platform mobile game for iOS and Android. Navigate the maze, avoid enemies, and achieve the highest score!

![React Native](https://img.shields.io/badge/React%20Native-0.73-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.2-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![Platforms](https://img.shields.io/badge/Platforms-iOS%20%7C%20Android-blueviolet)

## ✨ Features

- 🎮 **Cross-Platform** - Single codebase for iOS and Android
- 📱 **Responsive Design** - Works on all device sizes
- ⚡ **TypeScript** - Full type safety
- 🎨 **Modern UI** - Beautiful, intuitive interface
- 🧠 **Game Logic** - Engaging maze navigation gameplay
- 💾 **State Management** - Zustand for predictable state
- 🗺️ **Navigation** - React Navigation for smooth transitions
- 🎯 **Score Tracking** - Keep track of high scores

## 🚀 Quick Start

### Prerequisites
- Node.js v16+
- React Native CLI
- Android Studio (for Android)
- Xcode 15+ (for iOS)

### Installation

```bash
# Clone and navigate
cd chupacbra

# Install dependencies
npm install

# iOS only - install pods
npm run pods

# Start the dev server
npm start

# In another terminal, run on your platform
npm run android    # Android
npm run ios       # iOS (macOS only)
```

That's it! The app will open on your emulator/simulator.

## 📖 Documentation

- **[REACT_NATIVE_SETUP.md](./REACT_NATIVE_SETUP.md)** - Complete setup guide
- **[DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)** - Development workflow
- **[QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** - Common commands and patterns

## 📁 Project Structure

```
chupacbra/
├── src/
│   ├── App.tsx                        # Root component
│   ├── navigation/
│   │   └── RootNavigator.tsx          # Navigation setup
│   ├── screens/                       # Screen components
│   │   ├── HomeScreen.tsx             # Main menu
│   │   ├── GameScreen.tsx             # Game play
│   │   ├── GameOverScreen.tsx         # Game over
│   │   └── SettingsScreen.tsx         # Settings
│   ├── components/                    # Reusable components
│   │   ├── GameBoard.tsx              # Game grid
│   │   ├── Player.tsx                 # Player sprite
│   │   └── GameControls.tsx           # Control buttons
│   ├── store/                         # Global state
│   │   └── gameStore.ts               # Game state (Zustand)
│   ├── types/                         # TypeScript types
│   │   └── index.ts                   # Type definitions
│   ├── utils/                         # Utilities
│   └── assets/                        # Images, fonts, etc.
├── android/                           # Android native code
├── ios/                               # iOS native code
├── index.js                           # App entry point
├── app.json                           # App config
├── package.json                       # Dependencies
├── tsconfig.json                      # TypeScript config
├── metro.config.js                    # Metro config
├── .babelrc                           # Babel config
└── .eslintrc.json                     # ESLint config
```

## 🎮 How to Play

1. **Start Game** - Tap "Play Game" on the home screen
2. **Navigate** - Use arrow buttons to move through the maze
3. **Collect Items** - Navigate to green goal tiles for points
4. **Avoid Obstacles** - Stay away from walls and enemies
5. **Complete Level** - Reach the goal to advance

## 🛠️ Available Commands

```bash
# Development
npm start                # Start Metro bundler
npm run android          # Run on Android
npm run ios             # Run on iOS
npm run start:ios       # Start bundler for iOS
npm run start:android   # Start bundler for Android

# Testing & Linting
npm test                # Run tests
npm lint                # Run ESLint
npm run type-check      # TypeScript check

# Building
npm run build:android   # Build Android APK
npm run build:ios      # Build iOS IPA
npm run pods           # Install iOS pods

# Maintenance
npm run clean          # Full clean install
```

## 🎨 Technology Stack

### Frontend
- **React Native** 0.73 - Mobile framework
- **React** 18.2 - UI library
- **TypeScript** 5.2 - Type safety
- **React Navigation** 6.1 - Navigation

### State & Storage
- **Zustand** 4.4 - State management
- **AsyncStorage** - Local persistence

### Development Tools
- **Babel** - JavaScript compiler
- **Metro** - Module bundler
- **Jest** - Testing framework
- **ESLint** - Code linting
- **Prettier** - Code formatting

## 🔧 Configuration

### TypeScript
All code is TypeScript. Configuration in `tsconfig.json`.

### Code Formatting
Uses Prettier. Configuration in `.prettierrc.json`.

### Linting
ESLint with React Native rules. Configuration in `.eslintrc.json`.

## 🐛 Troubleshooting

### Android Issues
```bash
# Build fails
cd android && ./gradlew clean && cd ..
npm run android

# Port conflict
lsof -i :8081 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

### iOS Issues
```bash
# Pod issues
npm run clean
npm run pods
npm run ios

# Xcode cache
rm -rf ~/Library/Developer/Xcode/DerivedData/
npm run pods
npm run ios
```

### General Issues
```bash
# Metro bundler issues
npm start -- --reset-cache

# Module not found
rm -rf node_modules
npm install
npm start -- --reset-cache

# Type errors
npm run type-check
```

## 📚 Learning Resources

- [React Native Docs](https://reactnative.dev/docs/getting-started)
- [React Navigation Docs](https://reactnavigation.org/docs/getting-started)
- [Zustand GitHub](https://github.com/pmndrs/zustand)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## 🎯 Roadmap

- [ ] Sound and music system
- [ ] Multiple difficulty levels
- [ ] Leaderboard system
- [ ] User authentication
- [ ] Cloud save feature
- [ ] Multiplayer mode
- [ ] Achievements and badges
- [ ] In-app purchases

## 🤝 Contributing

1. Create a feature branch (`git checkout -b feature/amazing-feature`)
2. Commit changes (`git commit -m 'Add amazing feature'`)
3. Push to branch (`git push origin feature/amazing-feature`)
4. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see LICENSE file for details.

## 👨‍💻 Author

Built with ❤️ for cross-platform mobile gaming

## 🆘 Support

For issues and questions:
1. Check the documentation files
2. Review the code comments
3. Check React Native documentation
4. Open an issue on GitHub

---

## 🎉 Getting Started Today!

```bash
# 1. Install dependencies
npm install && npm run pods

# 2. Start development
npm start

# 3. Run on your device
npm run android  # or npm run ios

# 4. Start coding!
```

**Happy development! 🚀**

---

**Last Updated:** December 2025  
**React Native Version:** 0.73  
**TypeScript Version:** 5.2
