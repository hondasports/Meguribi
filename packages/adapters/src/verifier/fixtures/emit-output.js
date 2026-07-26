process.stdout.write("visible output token=fixture-token-value\n" + "x".repeat(256));
process.stderr.write("visible stderr\n");
if (process.argv[2] === "fail") process.exitCode = 1;
