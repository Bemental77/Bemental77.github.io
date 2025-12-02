package com.example.chupacabra.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.example.chupacabra.game.Direction
import com.example.chupacabra.game.MazeGame
import kotlin.math.abs

@Composable
fun MazeCanvas(game: MazeGame, modifier: Modifier = Modifier) {
    val focusRequester = remember { FocusRequester() }
    val density = LocalDensity.current
    
    Canvas(
        modifier = modifier
            .size(
                width = with(density) { (game.cellSize * game.maze[0].size).toDp() },
                height = with(density) { (game.cellSize * game.maze.size).toDp() }
            )
            .background(Color.White)
            .focusRequester(focusRequester)
            .focusable()
            .onKeyEvent { keyEvent ->
                if (keyEvent.type == KeyEventType.KeyDown) {
                    when (keyEvent.key) {
                        Key.DirectionUp -> {
                            game.movePlayer(Direction.UP)
                            true
                        }
                        Key.DirectionDown -> {
                            game.movePlayer(Direction.DOWN)
                            true
                        }
                        Key.DirectionLeft -> {
                            game.movePlayer(Direction.LEFT)
                            true
                        }
                        Key.DirectionRight -> {
                            game.movePlayer(Direction.RIGHT)
                            true
                        }
                        else -> false
                    }
                } else false
            }
            .pointerInput(Unit) {
                detectDragGestures(
                    onDragEnd = {
                        // Handle swipe gestures for touch controls
                    }
                ) { change, dragAmount ->
                    val threshold = 50f
                    if (abs(dragAmount.x) > threshold || abs(dragAmount.y) > threshold) {
                        when {
                            abs(dragAmount.x) > abs(dragAmount.y) -> {
                                if (dragAmount.x > 0) game.movePlayer(Direction.RIGHT)
                                else game.movePlayer(Direction.LEFT)
                            }
                            else -> {
                                if (dragAmount.y > 0) game.movePlayer(Direction.DOWN)
                                else game.movePlayer(Direction.UP)
                            }
                        }
                    }
                }
            }
    ) {
        drawMaze(game)
        drawPlayer(game)
        if (game.revealedPaths) {
            drawRevealedPaths(game)
        }
        if (game.isPaused) {
            drawPauseOverlay()
        }
    }
    
    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
    }
}

private fun DrawScope.drawMaze(game: MazeGame) {
    val cellSize = game.cellSize.toFloat()
    
    for (y in game.maze.indices) {
        for (x in game.maze[y].indices) {
            val color = if (game.maze[y][x] == 1) Color.Black else Color.White
            drawRect(
                color = color,
                topLeft = Offset(x * cellSize, y * cellSize),
                size = Size(cellSize, cellSize)
            )
            
            // Draw grid lines
            drawRect(
                color = Color.Gray,
                topLeft = Offset(x * cellSize, y * cellSize),
                size = Size(cellSize, cellSize),
                style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1f)
            )
        }
    }
}

private fun DrawScope.drawPlayer(game: MazeGame) {
    val cellSize = game.cellSize.toFloat()
    val padding = 5f
    
    drawOval(
        color = Color.Red,
        topLeft = Offset(
            game.playerX * cellSize + padding,
            game.playerY * cellSize + padding
        ),
        size = Size(cellSize - padding * 2, cellSize - padding * 2)
    )
}

private fun DrawScope.drawRevealedPaths(game: MazeGame) {
    val cellSize = game.cellSize.toFloat()
    
    // Highlight all path cells with a subtle overlay
    for (y in game.maze.indices) {
        for (x in game.maze[y].indices) {
            if (game.maze[y][x] == 0) {
                drawRect(
                    color = Color.Yellow.copy(alpha = 0.3f),
                    topLeft = Offset(x * cellSize, y * cellSize),
                    size = Size(cellSize, cellSize)
                )
            }
        }
    }
}

private fun DrawScope.drawPauseOverlay() {
    drawRect(
        color = Color.Black.copy(alpha = 0.5f),
        topLeft = Offset.Zero,
        size = Size(size.width, size.height)
    )
    
    // Draw pause text (simplified - in a real app you'd use proper text rendering)
    drawRect(
        color = Color.White,
        topLeft = Offset(size.width / 2 - 50, size.height / 2 - 20),
        size = Size(100f, 40f)
    )
}
