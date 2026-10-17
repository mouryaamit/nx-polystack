import * as readline from 'readline';

import { CliError } from './types';

/** Asks one question at a time; tests pass their own answers. */
export interface Prompter {
  /** The answer, trimmed; the default when the answer is empty. */
  ask(question: string, defaultValue?: string): Promise<string>;
  close(): void;
}

/** Questions are asked only when both ends are a terminal. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A prompter on stdin/stdout (Node readline; no extra dependency). */
export function terminalPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question, defaultValue) =>
      new Promise((resolve) => {
        const hint = defaultValue !== undefined && defaultValue !== '' ? ` [${defaultValue}]` : '';
        rl.question(`${question}${hint}: `, (answer) => {
          const a = answer.trim();
          resolve(a === '' ? defaultValue ?? '' : a);
        });
      }),
    close: () => rl.close(),
  };
}

/** A prompter answering from a list (tests); throws when it runs out. */
export function scriptedPrompter(answers: string[], asked: string[] = []): Prompter {
  const queue = [...answers];
  return {
    ask: async (question, defaultValue) => {
      asked.push(question);
      if (queue.length === 0) throw new Error(`no scripted answer for "${question}"`);
      const a = (queue.shift() ?? '').trim();
      return a === '' ? defaultValue ?? '' : a;
    },
    close: () => undefined,
  };
}

const MAX_TRIES = 3;

/**
 * Asks until `check` accepts the answer (it returns the problem, or undefined); gives up after
 * three tries.
 */
export async function askValid(
  p: Prompter,
  question: string,
  defaultValue: string | undefined,
  check: (answer: string) => string | undefined,
  say: (line: string) => void = (l) => console.log(l),
): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const answer = await p.ask(question, defaultValue);
    const problem = check(answer);
    if (!problem) return answer;
    say(`  ${problem}`);
  }
  throw new CliError(`no valid answer to "${question}"; nothing was changed.`);
}
