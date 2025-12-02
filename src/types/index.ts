// Game state types
export interface PlayerState {
  x: number;
  y: number;
  score: number;
}

export interface GameState {
  player: PlayerState;
  isGameOver: boolean;
  isPaused: boolean;
  level: number;
  maze: MazeData;
}

export interface MazeData {
  width: number;
  height: number;
  tiles: Tile[][];
}

export interface Tile {
  type: 'wall' | 'path' | 'goal' | 'enemy';
  walkable: boolean;
}

// Navigation types
export type RootStackParamList = {
  Home: undefined;
  Game: undefined;
  GameOver: { score: number };
  Settings: undefined;
};

export type BottomTabParamList = {
  GameTab: undefined;
  SettingsTab: undefined;
  LeaderboardTab: undefined;
};
