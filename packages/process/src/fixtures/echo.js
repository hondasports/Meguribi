process.stdin.pipe(process.stdout);
process.stdin.on("end", () => {
  process.exit(0);
});
