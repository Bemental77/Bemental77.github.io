package com.example.chupacabra.game

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class MazeGame {
    // Maze: 0 = path, 1 = wall
    val maze = arrayOf(
        arrayOf(1,1,1,1,1,1,1,1,1,1),
        arrayOf(1,0,0,0,1,0,0,0,0,1),
        arrayOf(1,0,1,0,1,0,1,1,0,1),
        arrayOf(1,0,1,0,0,0,1,0,0,1),
        arrayOf(1,0,1,1,1,0,1,0,1,1),
        arrayOf(1,0,0,0,1,0,0,0,0,1),
        arrayOf(1,1,1,0,1,1,1,1,0,1),
        arrayOf(1,0,0,0,0,0,0,1,0,1),
        arrayOf(1,0,1,1,1,1,0,1,0,1),
        arrayOf(1,1,1,1,1,1,1,1,1,1),
    )

    val cellSize = 40
    
    // Player position state
    var playerX by mutableStateOf(1)
        private set
    var playerY by mutableStateOf(1)
        private set

    // Game state
    var isPaused by mutableStateOf(false)
        private set
    
    var revealedPaths by mutableStateOf(false)
        private set

    fun movePlayer(direction: Direction) {
        if (isPaused) return
        
        var newX = playerX
        var newY = playerY
        
        when (direction) {
            Direction.UP -> newY--
            Direction.DOWN -> newY++
            Direction.LEFT -> newX--
            Direction.RIGHT -> newX++
        }
        
        // Check bounds and walls
        if (newX >= 0 && newX < maze[0].size && 
            newY >= 0 && newY < maze.size && 
            maze[newY][newX] == 0) {
            playerX = newX
            playerY = newY
        }
    }
    
    fun jump(direction: Direction) {
        if (isPaused) return
        
        var newX = playerX
        var newY = playerY
        
        // Jump 2 cells in the direction
        when (direction) {
            Direction.UP -> newY -= 2
            Direction.DOWN -> newY += 2
            Direction.LEFT -> newX -= 2
            Direction.RIGHT -> newX += 2
        }
        
        // Check bounds and if destination is a path
        if (newX >= 0 && newX < maze[0].size && 
            newY >= 0 && newY < maze.size && 
            maze[newY][newX] == 0) {
            playerX = newX
            playerY = newY
        }
    }
    
    fun breakWall(direction: Direction) {
        if (isPaused) return
        
        var wallX = playerX
        var wallY = playerY
        
        when (direction) {
            Direction.UP -> wallY--
            Direction.DOWN -> wallY++
            Direction.LEFT -> wallX--
            Direction.RIGHT -> wallX++
        }
        
        // Check bounds and if it's a wall
        if (wallX >= 0 && wallX < maze[0].size && 
            wallY >= 0 && wallY < maze.size && 
            maze[wallY][wallX] == 1) {
            // Can't modify the original array directly in Compose
            // In a real implementation, you'd use a mutable state for the maze
        }
    }
    
    fun teleport(x: Int, y: Int) {
        if (isPaused) return
        
        // Check bounds and if destination is a path
        if (x >= 0 && x < maze[0].size && 
            y >= 0 && y < maze.size && 
            maze[y][x] == 0) {
            playerX = x
            playerY = y
        }
    }
    
    fun toggleRevealPath() {
        revealedPaths = !revealedPaths
    }
    
    fun togglePause() {
        isPaused = !isPaused
    }
}

enum class Direction {
    UP, DOWN, LEFT, RIGHT
}
