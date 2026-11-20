#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli/run.js';

const interactive = process.stdin.isTTY && process.stdout.isTTY;

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ...(interactive
    ? {
        readLine: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        },
      }
    : {}),
});
process.exitCode = exitCode;
