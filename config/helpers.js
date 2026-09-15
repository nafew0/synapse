/**
 * Helper functions
 * This allows us to give the console some colour when running in a terminal
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { execSync } = require('child_process');

/** @typedef {(message: string) => void} ConsoleColor */
/** @typedef {{ orange: ConsoleColor, green: ConsoleColor, red: ConsoleColor, blue: ConsoleColor, purple: ConsoleColor, cyan: ConsoleColor, yellow: ConsoleColor, white: ConsoleColor, gray: ConsoleColor }} ColoredConsole */

const coloredConsole = /** @type {Console & ColoredConsole} */ (console);

/** @param {string} query @returns {Promise<string>} */
const askQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question('\x1b[36m' + query + '\n> ' + '\x1b[0m', (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
};

/**
 * @param {string} query
 * @param {NodeJS.ReadableStream} [input]
 * @param {NodeJS.WritableStream} [destination]
 * @returns {Promise<string>}
 */
const askSilentQuestion = (query, input = process.stdin, destination = process.stdout) => {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        destination.write(chunk, encoding);
      }
      callback();
    },
  });
  output.isTTY = destination.isTTY;

  const rl = readline.createInterface({
    input,
    output,
    terminal: input.isTTY,
  });

  destination.write(query);
  muted = true;

  return new Promise((resolve) =>
    rl.question('', (answer) => {
      muted = false;
      destination.write('\n');
      rl.close();
      resolve(answer);
    }),
  );
};

/** @param {string} query @returns {Promise<string>} */
const askMultiLineQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  coloredConsole.cyan(query);

  return new Promise((resolve) => {
    /** @type {string[]} */
    const lines = [];
    rl.on('line', (line) => {
      if (line.trim() === '.') {
        rl.close();
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    });
  });
};

/**
 * @template T
 * @typedef {{ label: string, value: T, hint?: string }} Choice
 */

/**
 * @template T
 * @param {Choice<T>[]} choices
 * @param {number} active
 * @returns {string}
 */
const renderChoices = (choices, active) =>
  choices
    .map((choice, i) => {
      const hint = choice.hint ? `\x1b[90m  ${choice.hint}\x1b[0m` : '';
      return i === active ? `\x1b[36m❯ ${choice.label}\x1b[0m${hint}` : `  ${choice.label}${hint}`;
    })
    .join('\n');

/**
 * Numbered fallback for non-interactive terminals (piped input, some CI shells).
 * @template T
 * @param {string} query
 * @param {Choice<T>[]} choices
 * @param {number} defaultIndex
 * @returns {Promise<T>}
 */
const askNumberedChoice = async (query, choices, defaultIndex) => {
  const list = choices
    .map((choice, i) => `  ${i + 1}) ${choice.label}${choice.hint ? ` — ${choice.hint}` : ''}`)
    .join('\n');
  for (;;) {
    const answer = await askQuestion(
      `${query}\n${list}\nChoose 1-${choices.length} (default ${defaultIndex + 1}):`,
    );
    if (answer.trim() === '') {
      return choices[defaultIndex].value;
    }
    const index = Number(answer.trim()) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choices[index].value;
    }
    coloredConsole.red(`Please enter a number between 1 and ${choices.length}.`);
  }
};

/**
 * @param {string} str
 * @param {string | undefined} keyName
 * @param {number} active
 * @param {number} count
 * @returns {number | null}
 */
const nextChoiceIndex = (str, keyName, active, count) => {
  if (keyName === 'up' || keyName === 'k') {
    return (active - 1 + count) % count;
  }
  if (keyName === 'down' || keyName === 'j' || keyName === 'tab') {
    return (active + 1) % count;
  }
  const number = Number(str);
  return Number.isInteger(number) && number >= 1 && number <= count ? number - 1 : null;
};

/**
 * Asks the user to pick one option with the arrow keys (or j/k, or its number) and Enter.
 * @template T
 * @param {string} query
 * @param {Choice<T>[]} choices
 * @param {number} [defaultIndex]
 * @returns {Promise<T>}
 */
const askChoice = (query, choices, defaultIndex = 0) => {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return askNumberedChoice(query, choices, defaultIndex);
  }

  let active = defaultIndex;
  const out = process.stdout;
  out.write(`\x1b[36m${query}\x1b[0m \x1b[90m(↑/↓ to move, Enter to select)\x1b[0m\n`);
  out.write('\x1b[?25l' + renderChoices(choices, active) + '\n');

  const redraw = () => {
    out.write(`\x1b[${choices.length}A\x1b[0J`);
    out.write(renderChoices(choices, active) + '\n');
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const finish = () => {
      input.removeListener('keypress', onKeypress);
      input.setRawMode(false);
      input.pause();
      out.write(`\x1b[${choices.length}A\x1b[0J`);
      out.write(`\x1b[32m✔\x1b[0m ${choices[active].label}\n\x1b[?25h`);
      resolve(choices[active].value);
    };

    /** @param {string} str @param {{ name?: string, ctrl?: boolean }} key */
    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        out.write('\x1b[?25h\n');
        process.exit(130);
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      const next = nextChoiceIndex(str, key.name, active, choices.length);
      if (next == null) {
        return;
      }
      active = next;
      redraw();
    };

    input.on('keypress', onKeypress);
  });
};

function isDockerRunning() {
  try {
    execSync('docker info');
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Recursively removes a directory's node_modules.
 * Retries on transient ENOTEMPTY/EBUSY errors that fs.rmSync intermittently
 * throws on macOS (APFS) and Windows when entries are removed concurrently.
 */
/** @param {string} dir */
function deleteNodeModules(dir) {
  const nodeModulesPath = path.join(dir, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    coloredConsole.purple(`Deleting node_modules in ${dir}`);
    fs.rmSync(nodeModulesPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const silentExit = (code = 0) => {
  console.log = () => {};
  process.exit(code);
};

// Set the console colours
coloredConsole.orange = (/** @type {string} */ msg) => console.log('\x1b[33m%s\x1b[0m', msg);
coloredConsole.green = (/** @type {string} */ msg) => console.log('\x1b[32m%s\x1b[0m', msg);
coloredConsole.red = (/** @type {string} */ msg) => console.log('\x1b[31m%s\x1b[0m', msg);
coloredConsole.blue = (/** @type {string} */ msg) => console.log('\x1b[34m%s\x1b[0m', msg);
coloredConsole.purple = (/** @type {string} */ msg) => console.log('\x1b[35m%s\x1b[0m', msg);
coloredConsole.cyan = (/** @type {string} */ msg) => console.log('\x1b[36m%s\x1b[0m', msg);
coloredConsole.yellow = (/** @type {string} */ msg) => console.log('\x1b[33m%s\x1b[0m', msg);
coloredConsole.white = (/** @type {string} */ msg) => console.log('\x1b[37m%s\x1b[0m', msg);
coloredConsole.gray = (/** @type {string} */ msg) => console.log('\x1b[90m%s\x1b[0m', msg);

module.exports = {
  askQuestion,
  askSilentQuestion,
  askMultiLineQuestion,
  askChoice,
  silentExit,
  isDockerRunning,
  deleteNodeModules,
  coloredConsole,
};
