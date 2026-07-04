module.exports = {
  apps: [
    {
      name: "jira-to-projector",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
