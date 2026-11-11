// Create a user:  npm run user:create -- <email> <owner|manager|viewer>
// The password is read from the terminal (not echoed, not passed as an argument).
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { configFromEnv, createApp } from "../app";
import type { Role } from "../core/types";

if (existsSync(".env")) process.loadEnvFile(".env");

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { _muted?: boolean };
    process.stdout.write(prompt);
    // Suppress echo of typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      out.write("\n");
      resolve(answer);
    });
  });
}

const [email, role = "owner"] = process.argv.slice(2);
if (!email || !["owner", "manager", "viewer"].includes(role)) {
  console.error("Usage: npm run user:create -- <email> <owner|manager|viewer>");
  process.exit(1);
}
const app = createApp(configFromEnv());
try {
  const password = await readSecret("Password (at least 12 characters): ");
  const user = app.auth.createUser(email, password, role as Role);
  console.log(`Created ${user.role} ${user.email}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await app.stop();
}
