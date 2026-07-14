import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const NODE_ENV = process.env.NODE_ENV || 'development';

async function main() {
  const children: ChildProcess[] = [];

  const cleanup = () => {
    console.log('[LAUNCHER] Shutting down child processes...');
    for (const child of children) {
      if (child && !child.killed) {
        child.kill();
      }
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  if (NODE_ENV !== 'production') {
    console.log('[LAUNCHER] Starting CipherChat in DEVELOPMENT mode...');

    // 1. Start Vite Dev Server on Port 3001
    console.log('[LAUNCHER] Spawning Vite development server on port 3001...');
    const viteProcess = spawn('npx', ['vite', '--port', '3001', '--host', '0.0.0.0'], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, PORT: '3001' }
    });
    children.push(viteProcess);

    viteProcess.on('exit', (code) => {
      console.log(`[LAUNCHER] Vite server exited with code ${code}`);
      cleanup();
      process.exit(code || 0);
    });
  } else {
    console.log('[LAUNCHER] Starting CipherChat in PRODUCTION mode...');
  }

  // 2. Start Python FastAPI Server on Port 3000
  console.log('[LAUNCHER] Spawning FastAPI Uvicorn server on port 3000...');
  const fastapiProcess = spawn('python3', [
    '-m', 'uvicorn', 'server:app',
    '--port', '3000',
    '--host', '0.0.0.0',
    '--log-level', 'info'
  ], {
    stdio: 'inherit',
    shell: true
  });
  children.push(fastapiProcess);

  fastapiProcess.on('exit', (code) => {
    console.log(`[LAUNCHER] FastAPI server exited with code ${code}`);
    cleanup();
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('[LAUNCHER] Unexpected error in launcher:', err);
  process.exit(1);
});
