# React Native App Structure & Flow

## 📱 App Navigation Flow

```
                           ┌─────────────────┐
                           │   App Entry     │
                           │   (index.ts)    │
                           └────────┬────────┘
                                    │
                           ┌────────▼────────┐
                           │    App.tsx      │
                           │ (Root Component)│
                           └────────┬────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │   RootNavigator.tsx           │
                    │   (React Navigation Stack)    │
                    └───────────────┬───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
   ┌─────────────┐         ┌──────────────┐         ┌──────────────┐
   │ HomeScreen  │────────▶│  GameScreen  │────────▶│ GameOverScreen
   │             │         │              │         │ (params: score)
   └─────────────┘         └──────────────┘         └──────────────┘
        │                       │
        │                       └─────────────┐
        │                                     │
        └──────────────▶ ┌──────────────┐    │
                        │ SettingsScreen
                        │              │
                        └──────────────┘
```

## 🏗️ Component Architecture

```
App (Root)
├── GestureHandlerRootView (Touch handling)
│   └── RootNavigator (Navigation Stack)
│       ├── HomeScreen
│       │   ├── ScrollView
│       │   ├── Title
│       │   ├── Info Box
│       │   ├── Buttons
│       │   └── Stats Box
│       │
│       ├── GameScreen
│       │   ├── Header
│       │   ├── GameBoard
│       │   │   ├── Maze Tiles (FlatList rendering)
│       │   │   └── Player Component
│       │   ├── GameControls
│       │   │   ├── D-Pad
│       │   │   └── Action Buttons
│       │   └── Back Button
│       │
│       ├── GameOverScreen
│       │   ├── Title
│       │   ├── Score Display
│       │   ├── Statistics
│       │   ├── Action Buttons
│       │   └── Info Box
│       │
│       └── SettingsScreen
│           ├── Audio Settings
│           ├── Game Settings
│           ├── About Info
│           └── Back Button
```

## 🎮 State Management Flow

```
┌──────────────────────────────────┐
│       useGameStore (Zustand)     │
└──────────────────────────────────┘
                │
    ┌───────────┴───────────┐
    │                       │
    ▼                       ▼
┌─────────────┐      ┌──────────────┐
│   State     │      │   Actions    │
├─────────────┤      ├──────────────┤
│ player      │      │ movePlayer   │
│ ├─ x        │      │ updateScore  │
│ ├─ y        │      │ togglePause  │
│ └─ score    │      │ resetGame    │
│             │      │ endGame      │
│ isGameOver  │      │ loadLevel    │
│ isPaused    │      │              │
│ level       │      │              │
│ maze        │      │              │
└─────────────┘      └──────────────┘
    │
    │ Used by Screens & Components
    │
    ├─── GameScreen
    ├─── GameBoard
    ├─── Player
    └─── GameControls
```

## 📊 Game State Object Structure

```typescript
GameState {
  player: {
    x: number;           // Position X
    y: number;           // Position Y
    score: number;       // Current score
  };
  isGameOver: boolean;   // Game end state
  isPaused: boolean;     // Pause state
  level: number;         // Current level
  maze: {
    width: number;       // Grid width
    height: number;      // Grid height
    tiles: Array[Array] {
      type: 'wall' | 'path' | 'goal' | 'enemy';
      walkable: boolean;
    }
  }
}
```

## 🎨 Screen Layouts

### HomeScreen Layout
```
┌─────────────────────────────────┐
│  🦙 Chupacabra Maze             │
│  Navigate the legendary maze    │
├─────────────────────────────────┤
│                                 │
│  ┌──────────────────────────┐   │
│  │ How to Play              │   │
│  │ • Use arrow buttons      │   │
│  │ • Collect all items      │   │
│  │ • Avoid enemies          │   │
│  │ • Complete levels        │   │
│  └──────────────────────────┘   │
│                                 │
│  ┌──────────┬──────────────┐    │
│  │Play Game │ Settings     │    │
│  └──────────┴──────────────┘    │
│                                 │
│  ┌──────────────────────────┐   │
│  │ Game Stats               │   │
│  │ High Score: Coming Soon  │   │
│  │ Levels Completed: 0      │   │
│  │ Total Play Time: 0h      │   │
│  └──────────────────────────┘   │
│                                 │
└─────────────────────────────────┘
```

### GameScreen Layout
```
┌─────────────────────────────────┐
│ Level 1          Score: 150      │
│ Position: (2, 3)                │
├─────────────────────────────────┤
│                                 │
│      Maze Rendering             │
│      ┌─────────────────┐        │
│      │█ █ █ █ █ █ █ █ │        │
│      │█ · · · █ · · █ │        │
│      │█ · █ · · · █ █ │        │
│      │█ ● · █ █ · · █ │  ●     │
│      │█ · · · █ · · █ │  Red   │
│      │█ █ █ █ █ █ █ █ │  Tile  │
│      └─────────────────┘        │
│                                 │
│      D-Pad Controls             │
│          ↑                      │
│      ← center →                 │
│          ↓                      │
│                                 │
│      [Pause] [Resume]           │
│                                 │
│    ← Back to Home               │
│                                 │
└─────────────────────────────────┘
```

### GameOverScreen Layout
```
┌─────────────────────────────────┐
│                                 │
│     GAME OVER                   │
│                                 │
│  ┌────────────────────────────┐ │
│  │    Final Score             │ │
│  │                            │ │
│  │           1250             │ │
│  │                            │ │
│  └────────────────────────────┘ │
│                                 │
│  ┌────────────────────────────┐ │
│  │ Stats                      │ │
│  │ Score: 1250                │ │
│  │ Status: Game Completed     │ │
│  └────────────────────────────┘ │
│                                 │
│  [Play Again]  [Back to Home]   │
│                                 │
│  ┌────────────────────────────┐ │
│  │ 🏆 Complete more levels to │ │
│  │ improve your score!        │ │
│  └────────────────────────────┘ │
│                                 │
└─────────────────────────────────┘
```

## 🔄 Data Flow Example: Move Player

```
User Action
    │
    ├─ Touch Arrow Button
    │
    ▼
GameControls Component
    │
    ├─ onPress event
    │
    ▼
handleMove(dx, dy)
    │
    ├─ Call movePlayer(dx, dy)
    │
    ▼
Zustand Store (gameStore.ts)
    │
    ├─ Validate new position
    ├─ Check if walkable
    ├─ Calculate score changes
    │
    ▼
State Update
    │
    player: {
      x: newX,
      y: newY,
      score: newScore
    }
    │
    ▼
Re-render Components
    │
    ├─ GameBoard (maze)
    ├─ Player (new position)
    └─ GameScreen (new score)
    │
    ▼
User sees updated position
```

## 🎯 File Dependencies

```
index.ts (Entry point)
    │
    └── App.tsx
        │
        └── RootNavigator.tsx
            │
            ├── HomeScreen.tsx
            ├── GameScreen.tsx
            │   ├── GameBoard.tsx
            │   │   ├── Player.tsx
            │   │   └── gameStore (Zustand)
            │   │
            │   ├── GameControls.tsx
            │   │   └── gameStore
            │   │
            │   └── types/index.ts
            │
            ├── GameOverScreen.tsx
            │   └── gameStore
            │
            └── SettingsScreen.tsx

Types Flow:
types/index.ts
    ├── RootStackParamList
    ├── BottomTabParamList
    ├── GameState
    ├── PlayerState
    ├── MazeData
    └── Tile
```

## 🔌 Component Props & State Flow

```
RootNavigator
    │
    ├─ navigation, route
    │
    └── HomeScreen
        ├─ Props: { navigation }
        └─ No local state
        
    └── GameScreen
        ├─ Props: { navigation, route }
        ├─ Local state: useGameStore()
        └─ Effects: resetGame on mount
        
    └── GameOverScreen
        ├─ Props: { navigation, route }
        ├─ Route params: { score }
        └─ No state management
```

## 📦 Dependencies Tree

```
React Native
├── react
├── react-native
├── @react-navigation/native
├── @react-navigation/stack
├── react-native-gesture-handler
├── react-native-reanimated
├── react-native-screens
├── react-native-safe-area-context
├── zustand (state management)
├── @react-native-camera-roll/camera-roll
└── Development Tools
    ├── typescript
    ├── babel
    ├── jest
    ├── eslint
    └── prettier
```

## 🚀 Development Workflow

```
1. Edit Code (src/ files)
    │
    ▼
2. Metro Bundler Hot Reloads
    │
    ▼
3. App Recompiles
    │
    ▼
4. Changes Visible on Device/Emulator
    │
    └─ Full Reload if needed: R key
```

---

**This visual guide shows the complete structure and flow of the Chupacabra React Native app!**
