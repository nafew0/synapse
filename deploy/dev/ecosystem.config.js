module.exports = {
  apps: [
    {
      name: 'synapse-dev',
      script: 'api/server/index.js',
      cwd: '/opt/synapse-dev/current',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '2G',
      wait_ready: true,
      listen_timeout: 90000,
      kill_timeout: 65000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
