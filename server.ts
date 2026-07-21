import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { spawn } from 'child_process';
import httpProxy from 'http-proxy';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 3000;
const FASTAPI_PORT = 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

async function startServer() {
  console.log('[PROXY SERVER] Spawning FastAPI backend server...');

  // Start FastAPI backend server on port 3001
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const pythonProcess = spawn(pythonCmd, [
    '-m', 'uvicorn',
    'server:app',
    '--host', '127.0.0.1',
    '--port', String(FASTAPI_PORT),
    '--log-level', 'info'
  ], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  pythonProcess.on('error', (err) => {
    console.error('[PROXY SERVER] Failed to start FastAPI process:', err);
  });

  pythonProcess.on('exit', (code, signal) => {
    console.log(`[PROXY SERVER] FastAPI process exited with code ${code} and signal ${signal}`);
  });

  // Ensure python process is terminated when node process exits
  process.on('exit', () => {
    pythonProcess.kill();
  });

  const app = express();
  const httpServer = createServer(app);

  // Initialize HTTP/WS proxy pointing to FastAPI
  const proxy = httpProxy.createProxyServer({});

  // Proxy API requests to FastAPI backend
  app.all('/api/*', (req, res) => {
    proxy.web(req, res, { target: `http://127.0.0.1:${FASTAPI_PORT}` }, (err) => {
      console.error('[PROXY SERVER] Error proxying API request:', err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'FastAPI server is starting up or currently unreachable.' });
      }
    });
  });

  // Handle WebSocket upgrade proxying to FastAPI backend
  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
    if (pathname === '/ws') {
      proxy.ws(request, socket, head, { target: `ws://127.0.0.1:${FASTAPI_PORT}` }, (err) => {
        console.error('[PROXY SERVER] Error proxying WebSocket connection:', err);
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });

  // Handle static assets/Vite middleware depending on environment
  if (NODE_ENV !== 'production') {
    console.log('[PROXY SERVER] Mounting Vite development server as middleware...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    console.log(`[PROXY SERVER] Operating in production. Serving static files from ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Start the reverse proxy server on PORT (3000)
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[PROXY SERVER] Gateway successfully running on http://localhost:${PORT}`);
    console.log(`[PROXY SERVER] Routing /api/* and /ws to FastAPI on port ${FASTAPI_PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[PROXY SERVER] Critical error starting proxy gateway:', err);
  process.exit(1);
});
