import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  clampHoldDelay,
  encodeHoldCommand,
  HOLD_DEFAULT_DELAY_MS,
  HOLD_HEALTHY_RESET_MS,
  HOLD_PROTOCOL_VERSION,
  HOLD_READY_TIMEOUT_MS,
  HOLD_STOP_GRACE_MS,
  HoldLineSplitter,
  parseHoldMessage,
  planHoldRestart,
  type HoldCommand,
  type HoldMessage,
} from "./hold-core.js";

// Supervises ke-pen-hold-helper: starts it with KE Pen, re-sends the current
// configuration every time it reports ready, restarts it with back-off when it
// dies, and stops it with the app. The helper starts disarmed and is armed
// only from here, so a helper nobody supervises never holds a click back.

export type HoldHelperState =
  | "stopped"
  | "starting"
  | "active"
  | "needs-permission"
  | "restarting"
  | "failed"
  | "unavailable";

export interface HoldHelperStatus {
  state: HoldHelperState;
  helperVersion: string | null;
  restarts: number;
  lastError: string | null;
}

export interface HoldTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface HoldSupervisorOptions {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  expectedVersion: string;
  onHold(sequence: number): void;
  onStatus?(status: HoldHelperStatus): void;
  timers?: HoldTimers;
  spawn?: SpawnFunction;
}

const realTimers: HoldTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class HoldHelperSupervisor {
  private readonly options: HoldSupervisorOptions;
  private readonly timers: HoldTimers;
  private readonly spawnProcess: SpawnFunction;
  private child: ChildProcess | null = null;
  private childReady = false;
  private wanted = false;
  private relaunchOnExit = false;
  private armed = false;
  private thresholdMs = HOLD_DEFAULT_DELAY_MS;
  private failures: number[] = [];
  private restartTimer: unknown = null;
  private readyTimer: unknown = null;
  private healthyTimer: unknown = null;
  private stopWaiters: Array<() => void> = [];
  private status: HoldHelperStatus = {
    state: "stopped",
    helperVersion: null,
    restarts: 0,
    lastError: null,
  };

  constructor(options: HoldSupervisorOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
    this.spawnProcess = options.spawn ?? (nodeSpawn as SpawnFunction);
  }

  get current(): HoldHelperStatus {
    return { ...this.status };
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    this.wanted = true;
    if (this.child || this.restartTimer !== null) return;
    if (this.status.state === "unavailable") return;
    this.launch();
  }

  // Manual restart from the tray: forget the failure history and try again.
  restart(): void {
    this.failures = [];
    this.clearTimer("restartTimer");
    this.wanted = true;
    this.status.restarts += 1;
    if (this.child) {
      this.relaunchOnExit = true;
      this.terminate(this.child);
      return;
    }
    this.setStatus({ state: "stopped", lastError: null });
    this.launch();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.clearTimer("restartTimer");
    this.clearTimer("readyTimer");
    this.clearTimer("healthyTimer");
    const child = this.child;
    if (!child) {
      if (this.status.state !== "unavailable") this.setStatus({ state: "stopped" });
      return;
    }
    const exited = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    this.terminate(child);
    await exited;
  }

  setArmed(armed: boolean): void {
    if (this.armed === armed) return;
    this.armed = armed;
    if (this.childReady) this.send(armed ? { cmd: "arm" } : { cmd: "disarm" });
  }

  // macOS only: asks the helper to show the system Accessibility alert for
  // itself. Sent only after the person chose to set hold to capture up.
  requestPermissionPrompt(): boolean {
    if (!this.childReady || this.status.state !== "needs-permission") return false;
    this.send({ cmd: "prompt" });
    return true;
  }

  configure(thresholdMs: number): void {
    const next = clampHoldDelay(thresholdMs);
    if (next === this.thresholdMs) return;
    this.thresholdMs = next;
    if (this.childReady) this.send({ cmd: "config", thresholdMs: next });
  }

  private launch(): void {
    let child: ChildProcess;
    this.childReady = false;
    try {
      child = this.spawnProcess(this.options.command, [...(this.options.args ?? [])], {
        stdio: ["pipe", "pipe", "ignore"],
        env: this.options.env ?? process.env,
        windowsHide: true,
      });
    } catch {
      this.setStatus({ state: "unavailable", lastError: "helper-missing" });
      return;
    }
    this.child = child;
    this.setStatus({ state: "starting" });
    const splitter = new HoldLineSplitter();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child !== child) return;
      for (const line of splitter.push(chunk)) this.handle(child, parseHoldMessage(line));
    });
    // A helper that has gone away must not take the app down with EPIPE.
    child.stdin?.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      if (error.code === "ENOENT" || error.code === "EACCES") {
        this.child = null;
        this.clearTimer("readyTimer");
        this.setStatus({ state: "unavailable", lastError: "helper-missing" });
        this.resolveStopWaiters();
      }
    });
    child.once("exit", () => this.handleExit(child));
    this.readyTimer = this.timers.setTimeout(() => {
      this.readyTimer = null;
      if (this.child === child && !this.childReady) {
        this.status.lastError = "no-ready";
        child.kill("SIGKILL");
      }
    }, HOLD_READY_TIMEOUT_MS);
  }

  private handle(child: ChildProcess, message: HoldMessage | null): void {
    if (!message) return;
    switch (message.type) {
      case "ready":
        if (message.protocol !== HOLD_PROTOCOL_VERSION || message.version !== this.options.expectedVersion) {
          // A helper from another build could speak a different contract.
          this.status.lastError = "version-mismatch";
          child.kill("SIGKILL");
          return;
        }
        this.childReady = true;
        this.clearTimer("readyTimer");
        this.status.helperVersion = message.version;
        this.send({ cmd: "config", thresholdMs: this.thresholdMs });
        this.send(this.armed ? { cmd: "arm" } : { cmd: "disarm" });
        return;
      case "active":
        if (!this.childReady) return;
        this.setStatus({ state: "active", lastError: null });
        this.clearTimer("healthyTimer");
        this.healthyTimer = this.timers.setTimeout(() => {
          this.healthyTimer = null;
          this.failures = [];
        }, HOLD_HEALTHY_RESET_MS);
        return;
      case "needs-permission":
        if (!this.childReady) return;
        this.setStatus({ state: "needs-permission" });
        return;
      case "hold":
        if (this.status.state === "active" && this.childReady) this.options.onHold(message.seq);
        return;
      case "tap-restored":
        return;
      case "error":
        this.status.lastError = message.code;
        return;
    }
  }

  private handleExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.childReady = false;
    this.clearTimer("readyTimer");
    this.clearTimer("healthyTimer");
    if (!this.wanted) {
      this.relaunchOnExit = false;
      this.setStatus({ state: "stopped" });
      this.resolveStopWaiters();
      return;
    }
    if (this.relaunchOnExit) {
      this.relaunchOnExit = false;
      this.setStatus({ lastError: null });
      this.launch();
      return;
    }
    const now = this.timers.now();
    this.failures.push(now);
    const plan = planHoldRestart(this.failures, now);
    this.failures = plan.recentFailures;
    if (plan.giveUp) {
      this.setStatus({ state: "failed", lastError: this.status.lastError ?? "exited" });
      this.resolveStopWaiters();
      return;
    }
    this.status.restarts += 1;
    this.setStatus({ state: "restarting", lastError: this.status.lastError ?? "exited" });
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child) this.launch();
    }, plan.delayMs);
    this.resolveStopWaiters();
  }

  private terminate(child: ChildProcess): void {
    this.send({ cmd: "quit" });
    child.stdin?.end();
    const timer = this.timers.setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, HOLD_STOP_GRACE_MS);
    child.once("exit", () => this.timers.clearTimeout(timer));
  }

  private send(command: HoldCommand): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(encodeHoldCommand(command));
  }

  private setStatus(patch: Partial<HoldHelperStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus?.({ ...this.status });
  }

  private clearTimer(name: "restartTimer" | "readyTimer" | "healthyTimer"): void {
    const handle = this[name];
    if (handle !== null) this.timers.clearTimeout(handle);
    this[name] = null;
  }

  private resolveStopWaiters(): void {
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
