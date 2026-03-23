/**
 * Mock for child_process spawn for CI testing
 *
 * This mock allows tests to run without actually spawning the Claude CLI,
 * useful for CI environments where the CLI may not be installed.
 */

import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

export interface MockSpawnOptions {
  exitCode?: number;
  stdout?: string[];
  stderr?: string[];
  error?: Error | null;
  delay?: number;
}

export interface MockChildProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid: number;
  killed: boolean;
  kill(signal?: string): boolean;
}

/**
 * Create a mock child process that simulates spawn behavior
 */
export function createMockChildProcess(options: MockSpawnOptions = {}): MockChildProcess {
  const {
    exitCode = 0,
    stdout = [],
    stderr = [],
    error = null,
    delay = 0,
  } = options;

  const emitter = new EventEmitter() as MockChildProcess;

  // Create mock streams
  const stdoutReadable = new Readable({
    read() {},
  });
  const stderrReadable = new Readable({
    read() {},
  });
  const stdinWritable = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  emitter.stdin = stdinWritable;
  emitter.stdout = stdoutReadable;
  emitter.stderr = stderrReadable;
  emitter.pid = Math.floor(Math.random() * 100000);
  emitter.killed = false;

  emitter.kill = (signal?: string) => {
    emitter.killed = true;
    emitter.emit("close", null, signal);
    return true;
  };

  // Schedule events
  setTimeout(() => {
    if (error) {
      emitter.emit("error", error);
      return;
    }

    // Send stdout chunks
    for (const chunk of stdout) {
      stdoutReadable.push(Buffer.from(chunk));
    }
    stdoutReadable.push(null);

    // Send stderr chunks
    for (const chunk of stderr) {
      stderrReadable.push(Buffer.from(chunk));
    }
    stderrReadable.push(null);

    // Emit close
    emitter.emit("close", exitCode);
  }, delay);

  return emitter;
}

/**
 * Create a mock spawn function
 */
export function createMockSpawn(defaultOptions: MockSpawnOptions = {}) {
  return (_command: string, _args?: string[], _options?: object): MockChildProcess => {
    return createMockChildProcess(defaultOptions);
  };
}

/**
 * Create mock spawn that returns different results based on command
 */
export function createConditionalMockSpawn(
  conditions: Map<string, MockSpawnOptions>
) {
  return (command: string, args?: string[], _options?: object): MockChildProcess => {
    // Check for exact command match
    if (conditions.has(command)) {
      return createMockChildProcess(conditions.get(command)!);
    }

    // Check for command with args match
    const fullCommand = args ? `${command} ${args.join(" ")}` : command;
    if (conditions.has(fullCommand)) {
      return createMockChildProcess(conditions.get(fullCommand)!);
    }

    // Default: simulate ENOENT
    return createMockChildProcess({
      error: Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
        syscall: "spawn",
        path: command,
      }),
    });
  };
}

/**
 * Mock spawn that simulates ENOENT error
 */
export function createEnoentSpawn(command: string = "claude") {
  return () =>
    createMockChildProcess({
      error: Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
        syscall: "spawn",
        path: command,
      }),
    });
}

/**
 * Mock spawn that simulates successful Claude response
 */
export function createSuccessSpawn(response: string) {
  return () =>
    createMockChildProcess({
      exitCode: 0,
      stdout: [response],
    });
}

/**
 * Mock spawn that simulates timeout
 */
export function createTimeoutSpawn(timeoutMs: number) {
  return () => {
    const child = createMockChildProcess({ delay: timeoutMs * 2 });
    // The caller should implement their own timeout logic
    return child;
  };
}
