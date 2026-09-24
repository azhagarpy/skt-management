// PM2 process definition for the API.
//
// .cjs rather than .js because package.json sets "type": "module" and PM2
// reads this file with require().
//
// The API loads its own .env (config/env.ts imports 'dotenv/config'), so cwd
// has to be the server directory - that is what makes server/.env resolve.
const path = require('node:path')

const serverDir = path.join(__dirname, 'server')

module.exports = {
  apps: [
    {
      name: 'skt-api',
      cwd: serverDir,
      script: path.join(serverDir, 'dist', 'server.js'),

      // One instance: server.ts applies pending migrations on boot. That is
      // guarded by a Postgres advisory lock so cluster mode would be safe, but
      // a single process is plenty for this headcount and keeps logs linear.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '20s',
      max_memory_restart: '512M',
      kill_timeout: 10000,

      env: {
        NODE_ENV: 'production',
      },

      time: true,
      merge_logs: true,
      error_file: '/opt/skt/logs/skt-api.error.log',
      out_file: '/opt/skt/logs/skt-api.out.log',
    },
  ],
}
