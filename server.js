const net = require('net');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const GAME_WIDTH = 40;
const GAME_HEIGHT = 20;
const FOOD_CHAR = '*';
const SNAKE_CHAR = '#';
const EMPTY_CHAR = ' ';
const LEADERBOARD_FILE = 'leaderboard.json';

class Leaderboard {
  constructor() {
    this.isUpdating = false;
    this.updateQueue = [];
    this.scores = this.loadScores();
  }

  loadScores() {
    try {
      if (fs.existsSync(LEADERBOARD_FILE)) {
        const data = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.log('Error loading leaderboard:', err);
    }
    return {};
  }

  async saveScores(scores) {
    const tempFile = LEADERBOARD_FILE + '.tmp';
    try {
      // Write to temporary file first (atomic operation)
      await promisify(fs.writeFile)(tempFile, JSON.stringify(scores, null, 2));
      // Then rename (atomic on most filesystems)
      await promisify(fs.rename)(tempFile, LEADERBOARD_FILE);
    } catch (err) {
      console.log('Error saving leaderboard:', err);
      // Clean up temp file if it exists
      try {
        await promisify(fs.unlink)(tempFile);
      } catch (unlinkErr) {
        // Ignore unlink errors
      }
      throw err;
    }
  }

  async processUpdateQueue() {
    if (this.isUpdating || this.updateQueue.length === 0) {
      return;
    }

    this.isUpdating = true;
    
    try {
      // Reload scores from file to get latest state
      const currentScores = this.loadScores();
      
      // Process all queued updates
      let hasChanges = false;
      const results = [];
      
      while (this.updateQueue.length > 0) {
        const { nickname, score, resolve } = this.updateQueue.shift();
        
        if (!currentScores[nickname] || currentScores[nickname] < score) {
          currentScores[nickname] = score;
          hasChanges = true;
          results.push({ resolve, isNewHighScore: true });
        } else {
          results.push({ resolve, isNewHighScore: false });
        }
      }
      
      // Save if there were changes
      if (hasChanges) {
        await this.saveScores(currentScores);
        this.scores = currentScores;
      }
      
      // Resolve all promises
      results.forEach(({ resolve, isNewHighScore }) => {
        resolve(isNewHighScore);
      });
      
    } catch (err) {
      console.log('Error processing leaderboard updates:', err);
      // Reject all queued promises
      while (this.updateQueue.length > 0) {
        const { reject } = this.updateQueue.shift();
        reject(err);
      }
    } finally {
      this.isUpdating = false;
      // Process any new items that came in while we were updating
      setImmediate(() => this.processUpdateQueue());
    }
  }

  updateScore(nickname, score) {
    return new Promise((resolve, reject) => {
      this.updateQueue.push({ nickname, score, resolve, reject });
      this.processUpdateQueue();
    });
  }

  getTopScores(limit = 10) {
    // Always reload from file for most current data
    const currentScores = this.loadScores();
    return Object.entries(currentScores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, limit);
  }

  formatLeaderboard() {
    const topScores = this.getTopScores();
    if (topScores.length === 0) {
      return 'No scores yet!\r\n';
    }

    let board = 'LEADERBOARD\r\n';
    board += '='.repeat(20) + '\r\n';
    topScores.forEach(([nickname, score], index) => {
      board += `${index + 1}. ${nickname}: ${score}\r\n`;
    });
    return board;
  }
}

const leaderboard = new Leaderboard();

class SnakeGame {
  constructor(socket) {
    this.socket = socket;
    this.snake = [{ x: 10, y: 10 }];
    this.direction = { x: 1, y: 0 };
    this.food = this.generateFood();
    this.score = 0;
    this.gameOver = false;
    this.gameRunning = false;
    this.nickname = '';
    this.enteringNickname = true;
    this.nicknameBuffer = '';
    this.showingLeaderboard = false;
    this.newHighScore = undefined;
  }

  generateFood() {
    let food;
    do {
      food = {
        x: Math.floor(Math.random() * GAME_WIDTH),
        y: Math.floor(Math.random() * GAME_HEIGHT)
      };
    } while (this.snake.some(segment => segment.x === food.x && segment.y === food.y));
    return food;
  }

  update() {
    if (this.gameOver || !this.gameRunning) return;

    const head = { ...this.snake[0] };
    head.x += this.direction.x;
    head.y += this.direction.y;

    if (head.x < 0 || head.x >= GAME_WIDTH || head.y < 0 || head.y >= GAME_HEIGHT) {
      this.gameOver = true;
      return;
    }

    if (this.snake.some(segment => segment.x === head.x && segment.y === head.y)) {
      this.gameOver = true;
      return;
    }

    this.snake.unshift(head);

    if (head.x === this.food.x && head.y === this.food.y) {
      this.score++;
      this.food = this.generateFood();
    } else {
      this.snake.pop();
    }
  }

  render() {
    let screen = '';
    
    // Clear screen and position cursor at top-left
    screen += '\x1b[2J\x1b[H';
    
    if (this.enteringNickname) {
      screen += 'Welcome to Snake Game!\r\n';
      screen += '='.repeat(20) + '\r\n';
      screen += 'Enter your nickname: ' + this.nicknameBuffer + '\r\n';
      screen += '(Press ENTER when done)\r\n';
    } else if (this.showingLeaderboard) {
      screen += leaderboard.formatLeaderboard();
      screen += '\r\nPress any key to continue...\r\n';
    } else {
      // Normal game view
      if (this.nickname) {
        screen += `Player: ${this.nickname} | Score: ${this.score}\r\n`;
      } else {
        screen += `Score: ${this.score}\r\n`;
      }
      
      // Top wall
      screen += '+' + '-'.repeat(GAME_WIDTH) + '+\r\n';

      // Game area with side walls
      for (let y = 0; y < GAME_HEIGHT; y++) {
        let row = '|';
        for (let x = 0; x < GAME_WIDTH; x++) {
          if (this.snake.some(segment => segment.x === x && segment.y === y)) {
            row += SNAKE_CHAR;
          } else if (this.food.x === x && this.food.y === y) {
            row += FOOD_CHAR;
          } else {
            row += EMPTY_CHAR;
          }
        }
        row += '|\r\n';
        screen += row;
      }

      // Bottom wall
      screen += '+' + '-'.repeat(GAME_WIDTH) + '+\r\n';

      // Status messages
      if (this.gameOver) {
        if (this.newHighScore === undefined && this.nickname) {
          // Update score asynchronously on first game over render
          leaderboard.updateScore(this.nickname, this.score).then(isNewHighScore => {
            this.newHighScore = isNewHighScore;
            this.render(); // Re-render with high score status
          }).catch(err => {
            console.log('Error updating leaderboard:', err);
            this.newHighScore = false;
          });
          this.newHighScore = null; // Mark as pending
        }
        
        if (this.newHighScore === true) {
          screen += '\r\nNEW HIGH SCORE!\r\n';
        }
        screen += '\r\n' + leaderboard.formatLeaderboard();
        screen += '\r\nGame Over! Press R to restart or Q to quit.\r\n';
      } else if (!this.gameRunning) {
        screen += '\r\nPress SPACE to start, WASD/Arrow keys to move, L for leaderboard, Q to quit.\r\n';
      } else {
        screen += '\r\nUse WASD/Arrow keys to move.\r\n';
      }
    }

    this.socket.write(screen);
  }

  handleInput(key) {
    const keyStr = key.toString().toLowerCase();
    
    // Handle nickname entry
    if (this.enteringNickname) {
      if (key === '\r' || key === '\n') { // Enter key
        if (this.nicknameBuffer.trim()) {
          this.nickname = this.nicknameBuffer.trim();
          this.enteringNickname = false;
          this.render();
        }
      } else if (key === '\b' || key === '\x7f') { // Backspace
        this.nicknameBuffer = this.nicknameBuffer.slice(0, -1);
        this.render();
      } else if (keyStr.length === 1 && keyStr.match(/[a-zA-Z0-9_-]/)) {
        if (this.nicknameBuffer.length < 15) {
          this.nicknameBuffer += keyStr;
          this.render();
        }
      }
      return;
    }

    // Handle leaderboard view
    if (this.showingLeaderboard) {
      this.showingLeaderboard = false;
      this.render();
      return;
    }
    
    if (keyStr === 'q' && (!this.gameRunning || this.gameOver)) {
      this.socket.end();
      return;
    }

    if (this.gameOver && keyStr === 'r') {
      this.restart();
      return;
    }

    if (!this.gameRunning && (keyStr === ' ' || key === '\r' || key === '\n')) {
      this.start();
      return;
    }

    if (!this.gameRunning && keyStr === 'l') {
      this.showingLeaderboard = true;
      this.render();
      return;
    }

    if (!this.gameRunning || this.gameOver) return;

    switch (keyStr) {
      case 'w':
        if (this.direction.y !== 1) {
          this.direction = { x: 0, y: -1 };
        }
        break;
      case 's':
        if (this.direction.y !== -1) {
          this.direction = { x: 0, y: 1 };
        }
        break;
      case 'a':
        if (this.direction.x !== 1) {
          this.direction = { x: -1, y: 0 };
        }
        break;
      case 'd':
        if (this.direction.x !== -1) {
          this.direction = { x: 1, y: 0 };
        }
        break;
    }
  }

  start() {
    this.gameRunning = true;
    this.gameLoop = setInterval(() => {
      this.update();
      this.render();
      if (this.gameOver) {
        clearInterval(this.gameLoop);
      }
    }, 150);
  }

  restart() {
    if (this.gameLoop) clearInterval(this.gameLoop);
    this.snake = [{ x: 10, y: 10 }];
    this.direction = { x: 1, y: 0 };
    this.food = this.generateFood();
    this.score = 0;
    this.gameOver = false;
    this.gameRunning = false;
    this.showingLeaderboard = false;
    this.newHighScore = undefined;
    this.render();
  }

  cleanup() {
    if (this.gameLoop) clearInterval(this.gameLoop);
  }
}

const server = net.createServer((socket) => {
  console.log('Client connected');
  
  const game = new SnakeGame(socket);
  
  // Force telnet into character mode (no line buffering)
  socket.write(Buffer.from([255, 251, 1])); // IAC WILL ECHO
  socket.write(Buffer.from([255, 251, 3])); // IAC WILL SUPPRESS_GO_AHEAD
  socket.write(Buffer.from([255, 253, 34])); // IAC DO LINEMODE
  // Disable linemode to get character-at-a-time input
  socket.write(Buffer.from([255, 250, 34, 1, 0, 255, 240])); // IAC SB LINEMODE MODE 0 IAC SE
  socket.write(Buffer.from([255, 252, 34])); // IAC WONT LINEMODE (disable it)
  
  // Set terminal to not echo and send chars immediately  
  socket.write('\x1b[?25l'); // Hide cursor during game
  socket.setNoDelay(true); // Disable Nagle algorithm for immediate response
  
  game.render();

  socket.on('data', (data) => {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      
      // Handle telnet IAC commands
      if (byte === 255) { // IAC
        if (i + 1 < data.length) {
          const command = data[i + 1];
          if (command === 250) { // SB (subnegotiation begin)
            // Skip until SE (subnegotiation end)
            while (i < data.length && !(data[i] === 255 && data[i + 1] === 240)) {
              i++;
            }
            i++; // Skip the SE
          } else if (command >= 251 && command <= 254) { // WILL/WONT/DO/DONT
            // Respond to negotiations
            if (command === 253 && i + 2 < data.length) { // DO
              const option = data[i + 2];
              if (option === 1 || option === 3) { // ECHO or SUPPRESS_GO_AHEAD
                socket.write(Buffer.from([255, 251, option])); // WILL
              } else {
                socket.write(Buffer.from([255, 252, option])); // WONT
              }
            }
            i += 2; // Skip command and option
          } else {
            i++; // Skip single byte command
          }
        }
        continue;
      }
      
      // Handle arrow key escape sequences
      if (byte === 27 && i + 2 < data.length && data[i + 1] === 91) { // ESC [
        const arrowKey = data[i + 2];
        switch (arrowKey) {
          case 65: // Up arrow
            game.handleInput('w');
            break;
          case 66: // Down arrow
            game.handleInput('s');
            break;
          case 68: // Left arrow
            game.handleInput('a');
            break;
          case 67: // Right arrow
            game.handleInput('d');
            break;
        }
        i += 2; // Skip the [ and arrow key byte
        continue;
      }
      
      // Process regular character input immediately
      if (byte >= 32 && byte <= 126) { // Printable ASCII
        game.handleInput(String.fromCharCode(byte));
      } else if (byte === 13 || byte === 10) { // CR or LF
        game.handleInput(String.fromCharCode(byte));
      }
      // Ignore all other bytes (function keys, etc.)
    }
  });

  socket.on('close', () => {
    console.log('Client disconnected');
    game.cleanup();
  });

  socket.on('error', (err) => {
    console.log('Socket error:', err);
    game.cleanup();
  });
});

const PORT = 2323;
server.listen(PORT, () => {
  console.log(`Snake game server listening on port ${PORT}`);
  console.log(`Connect with: telnet localhost ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});