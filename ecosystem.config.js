module.exports = {
  apps: [
    {
      name: 'kiwiverse-all-in-one',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '500M',
    },
  ],
};

