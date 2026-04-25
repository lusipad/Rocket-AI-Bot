module.exports = {
  apps: [{
    name: 'RocketBot',
    script: 'dist/index.js',
    instances: 1,
    max_memory_restart: '500M',
    error_file: 'data/logs/pm2-error.log',
    out_file: 'data/logs/pm2-out.log',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
