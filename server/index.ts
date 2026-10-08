import { createApp, createDeps } from './app.js';
import { config } from './config.js';

const app = createApp(createDeps());

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[yukti] listening on http://${config.HOST}:${config.PORT} | Test Orbit API ${config.testorbitApiUrl} | MCP ${config.mcpBaseUrl}/mcp`);
});

function shutdown(signal: string) {
  console.log(`[yukti] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
