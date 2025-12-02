import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface PlayerProps {
  x: number;
  y: number;
  tileSize: number;
}

export const Player: React.FC<PlayerProps> = ({ x, y, tileSize }) => {
  const position = React.useMemo(
    () => ({
      left: x * tileSize,
      top: y * tileSize,
    }),
    [x, y, tileSize]
  );

  return (
    <View
      style={[
        styles.player,
        {
          width: tileSize,
          height: tileSize,
          left: position.left,
          top: position.top,
        },
      ]}
    />
  );
};

const styles = StyleSheet.create({
  player: {
    position: 'absolute',
    backgroundColor: '#FF6B6B',
    borderRadius: 4,
  },
});
