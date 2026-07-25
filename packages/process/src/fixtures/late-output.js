process.stdout.write("start\n", () => {
  process.stdout.write("late\n", () => {
    process.exit(0);
  });
});

setInterval(() => {}, 1000);
