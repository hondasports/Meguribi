const keys = Object.keys(process.env).sort();
process.stdout.write(keys.join("\n") + (keys.length > 0 ? "\n" : ""));
process.exit(0);
