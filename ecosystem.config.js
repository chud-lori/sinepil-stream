module.exports = {
  apps: [
    {
      name:      'sinepilstream',
      script:    'server.js',
      instances: 1,          // single instance — SQLite doesn't support multi-process writes
      exec_mode: 'fork',

      // Zero-downtime reload handshake:
      // PM2 waits for process.send('ready') before considering the new process live,
      // so the old process keeps serving traffic until the new one is ready.
      wait_ready:     true,
      listen_timeout: 12000, // ms to wait for 'ready' signal before giving up
      kill_timeout:   10000, // ms to wait for in-flight requests before SIGKILL

      env: {
        NODE_ENV: 'production',
        PORT:     3500,
      },

      // Auto-restart on crash; cap memory for <2 GB servers.
      autorestart:        true,
      max_memory_restart: '300M',
      restart_delay:      1000,
      max_restarts:       10,

      // Log files (./logs is mounted as a volume in Docker too)
      out_file:        './logs/out.log',
      error_file:      './logs/error.log',
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
