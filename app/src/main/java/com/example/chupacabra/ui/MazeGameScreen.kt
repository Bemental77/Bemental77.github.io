package com.example.chupacabra.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.example.chupacabra.game.Direction
import com.example.chupacabra.game.MazeGame

@Composable
fun MazeGameScreen() {
    val game = remember { MazeGame() }
    
    Column(modifier = Modifier.fillMaxSize()) {
        // Game Status Bar
        GameStatusBar(game = game)
        
        // Maze Area (game)
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center
        ) {
            MazeCanvas(game = game)
        }
        
        // Control Buttons
        GameControlsSection(game = game)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GameStatusBar(game: MazeGame) {
    TopAppBar(
        title = { 
            Text("Chupacabra Maze Game") 
        },
        actions = {
            if (game.isPaused) {
                Text(
                    text = "PAUSED",
                    color = Color.Red,
                    modifier = Modifier.padding(end = 16.dp)
                )
            }
        }
    )
}

@Composable
fun GameControlsSection(game: MazeGame) {
    Column {
        // Movement Controls
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp)
            ) {
                Text(
                    text = "Movement",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                
                // Arrow pad for movement
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Button(
                        onClick = { game.movePlayer(Direction.UP) },
                        modifier = Modifier.size(64.dp)
                    ) {
                        Text("↑")
                    }
                    
                    Row {
                        Button(
                            onClick = { game.movePlayer(Direction.LEFT) },
                            modifier = Modifier.size(64.dp)
                        ) {
                            Text("←")
                        }
                        
                        Spacer(modifier = Modifier.width(64.dp))
                        
                        Button(
                            onClick = { game.movePlayer(Direction.RIGHT) },
                            modifier = Modifier.size(64.dp)
                        ) {
                            Text("→")
                        }
                    }
                    
                    Button(
                        onClick = { game.movePlayer(Direction.DOWN) },
                        modifier = Modifier.size(64.dp)
                    ) {
                        Text("↓")
                    }
                }
            }
        }
        
        // Skill Buttons
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp)
            ) {
                Text(
                    text = "Skills",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    SkillButton(
                        label = "Jump",
                        enabled = !game.isPaused,
                        onClick = { 
                            // For now, jump up - could add direction selection
                            game.jump(Direction.UP)
                        }
                    )
                    
                    SkillButton(
                        label = "Break Wall",
                        enabled = !game.isPaused,
                        onClick = { 
                            // For now, break wall above - could add direction selection
                            game.breakWall(Direction.UP)
                        }
                    )
                    
                    SkillButton(
                        label = "Teleport",
                        enabled = !game.isPaused,
                        onClick = { 
                            // For now, teleport to a random valid position
                            // In a real game, you'd show a selection interface
                            game.teleport(7, 7)
                        }
                    )
                }
                
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    SkillButton(
                        label = if (game.revealedPaths) "Hide Path" else "Reveal Path",
                        enabled = true,
                        onClick = { game.toggleRevealPath() }
                    )
                    
                    SkillButton(
                        label = if (game.isPaused) "Resume" else "Pause",
                        enabled = true,
                        onClick = { game.togglePause() }
                    )
                }
            }
        }
    }
}

@Composable
fun SkillButton(
    label: String, 
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .height(48.dp)
            .width(80.dp)
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall
        )
    }
}
