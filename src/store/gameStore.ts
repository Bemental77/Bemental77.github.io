import { create } from 'zustand';
import { GameState, PlayerState, MazeData } from '@types/index';

interface GameStore extends GameState {
  // Actions
  resetGame: () => void;
  movePlayer: (dx: number, dy: number) => void;
  updateScore: (points: number) => void;
  togglePause: () => void;
  loadLevel: (levelNumber: number) => void;
  endGame: () => void;
}

const initialMaze: MazeData = {
  width: 10,
  height: 10,
  tiles: Array(10)
    .fill(null)
    .map(() =>
      Array(10)
        .fill(null)
        .map(() => ({ type: 'path' as const, walkable: true }))
    ),
};

const initialPlayer: PlayerState = {
  x: 0,
  y: 0,
  score: 0,
};

export const useGameStore = create<GameStore>((set) => ({
  player: initialPlayer,
  isGameOver: false,
  isPaused: false,
  level: 1,
  maze: initialMaze,

  resetGame: () =>
    set({
      player: initialPlayer,
      isGameOver: false,
      isPaused: false,
      level: 1,
    }),

  movePlayer: (dx: number, dy: number) =>
    set((state) => {
      const newX = state.player.x + dx;
      const newY = state.player.y + dy;

      // Check bounds and walkability
      if (
        newX >= 0 &&
        newX < state.maze.width &&
        newY >= 0 &&
        newY < state.maze.height &&
        state.maze.tiles[newY][newX].walkable
      ) {
        const tile = state.maze.tiles[newY][newX];
        let scoreIncrease = 0;

        if (tile.type === 'goal') {
          scoreIncrease = 100;
        } else if (tile.type === 'path') {
          scoreIncrease = 1;
        }

        return {
          player: {
            ...state.player,
            x: newX,
            y: newY,
            score: state.player.score + scoreIncrease,
          },
        };
      }

      return state;
    }),

  updateScore: (points: number) =>
    set((state) => ({
      player: {
        ...state.player,
        score: state.player.score + points,
      },
    })),

  togglePause: () =>
    set((state) => ({
      isPaused: !state.isPaused,
    })),

  loadLevel: (levelNumber: number) =>
    set({
      level: levelNumber,
      player: { ...initialPlayer, score: initialPlayer.score },
      isGameOver: false,
      isPaused: false,
    }),

  endGame: () =>
    set({
      isGameOver: true,
      isPaused: true,
    }),
}));
