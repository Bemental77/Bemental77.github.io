import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { useGameStore } from '@store/gameStore';
import { Player } from './Player';

const TILE_SIZE = 30;

export const GameBoard: React.FC = () => {
  const { maze, player } = useGameStore();
  const screenWidth = Dimensions.get('window').width;

  const boardSize = Math.min(screenWidth - 20, TILE_SIZE * maze.width);
  const tileSize = boardSize / maze.width;

  return (
    <View
      style={[
        styles.board,
        {
          width: boardSize,
          height: boardSize,
        },
      ]}
    >
      {/* Render maze tiles */}
      {maze.tiles.map((row, y) =>
        row.map((tile, x) => (
          <View
            key={`${x}-${y}`}
            style={[
              styles.tile,
              {
                width: tileSize,
                height: tileSize,
                backgroundColor: getTileColor(tile.type),
                borderWidth: 0.5,
                borderColor: '#ccc',
              },
            ]}
          />
        ))
      )}

      {/* Render player */}
      <Player x={player.x} y={player.y} tileSize={tileSize} />
    </View>
  );
};

function getTileColor(type: string): string {
  switch (type) {
    case 'wall':
      return '#333';
    case 'path':
      return '#fff';
    case 'goal':
      return '#4CAF50';
    case 'enemy':
      return '#FF9800';
    default:
      return '#fff';
  }
}

const styles = StyleSheet.create({
  board: {
    position: 'relative',
    backgroundColor: '#f5f5f5',
    borderWidth: 2,
    borderColor: '#333',
    borderRadius: 8,
    overflow: 'hidden',
  },
  tile: {
    position: 'absolute',
  },
});
