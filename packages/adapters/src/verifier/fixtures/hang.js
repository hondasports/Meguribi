process.on("SIGTERM", () => {
  // ignored so ProcessRunner must escalate after timeout
});
process.on("SIGINT", () => {
  // ignored
});
setInterval(() => {}, 1000);
