export enum ShellState {
  READY = "ready",
  LOCKED = "locked",
  UNLOCKING = "unlocking",
  ERROR = "error",
  UNKNOWN = "unknown",
}

export interface UnlockStep {
  send: string;
  expectPattern: string;
  timeoutMs: number;
  description: string;
  userInput?: boolean;
}

export interface ShellProfile {
  name: string;
  description: string;
  statePatterns: {
    ready: string[];
    locked: string[];
    unlocking: string[];
    error: string[];
  };
  unlockSequence: UnlockStep[];
  challengeCodePattern?: string;
  features?: {
    bypassOnNonTty?: boolean;
    signalResistant?: boolean;
  };
}

type CompiledPatterns = {
  ready: RegExp[];
  locked: RegExp[];
  unlocking: RegExp[];
  error: RegExp[];
};

const BUILTIN_PROFILES: Record<string, ShellProfile> = {
  psh: {
    name: "psh",
    description: "Protect Shell - Davinci system locked shell, requires 'debug' command + password to unlock",
    statePatterns: {
      ready: [
        ".*[@:].*[#$]\\s*$",
        "PSH_AUTH=1",
        "built-in shell \\(ash\\)",
      ],
      locked: [
        "Protect Shell",
        "System is LOCKED",
        "^locked>\\s*$",
        "Command not supported in locked mode",
        "davinci system commands",
      ],
      unlocking: [
        "Enter key to unlock",
        "^key>\\s*$",
        "Password:\\s*$",
      ],
      error: [
        "Invalid key",
        "Returning to locked mode",
        "Access denied",
      ],
    },
    challengeCodePattern: "PSH-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}",
    unlockSequence: [
      {
        send: "debug",
        expectPattern: "Password:|key>|Enter key",
        timeoutMs: 10000,
        description: "Enter debug mode to trigger password prompt",
      },
      {
        send: "",
        expectPattern: "Access Granted|built-in shell|[@:].*[#$]",
        timeoutMs: 15000,
        description: "Submit unlock password",
        userInput: true,
      },
    ],
    features: {
      bypassOnNonTty: true,
      signalResistant: true,
    },
  },
};

function buildProfileFromEnv(): ShellProfile | null {
  const lockedPrompt = process.env.BOARD_LOCKED_PROMPT;
  const unlockingPrompt = process.env.BOARD_UNLOCKING_PROMPT;
  const readyPrompt = process.env.BOARD_READY_PROMPT;
  const errorPrompt = process.env.BOARD_ERROR_PROMPT;
  const sequenceStr = process.env.BOARD_UNLOCK_SEQUENCE;

  if (!lockedPrompt && !unlockingPrompt && !sequenceStr) {
    return null;
  }

  const patterns: ShellProfile["statePatterns"] = {
    ready: readyPrompt ? [readyPrompt] : [".*[@:].*[#$]\\s*$"],
    locked: lockedPrompt
      ? lockedPrompt.split("|").filter(Boolean)
      : ["locked>"],
    unlocking: unlockingPrompt
      ? unlockingPrompt.split("|").filter(Boolean)
      : ["key>"],
    error: errorPrompt
      ? errorPrompt.split("|").filter(Boolean)
      : ["invalid\\s+(key|password)", "access\\s+denied"],
  };

  const unlockSequence: UnlockStep[] = sequenceStr
    ? sequenceStr.split("||").map((step, idx) => {
        const parts = step.split("=>", 2);
        const send = (parts[0] ?? "").trim();
        const userInput = send === "";
        return {
          send: userInput ? "" : send,
          expectPattern: (parts[1] ?? ".*").trim(),
          timeoutMs: 5000,
          description: userInput ? `Step ${idx + 1} (user key)` : `Step ${idx + 1}`,
          userInput,
        };
      })
    : [];

  return {
    name: "custom",
    description: "User-defined shell profile",
    statePatterns: patterns,
    unlockSequence,
  };
}

function compilePatterns(profile: ShellProfile): CompiledPatterns {
  return {
    ready: profile.statePatterns.ready.map((p) => new RegExp(p, "i")),
    locked: profile.statePatterns.locked.map((p) => new RegExp(p, "i")),
    unlocking: profile.statePatterns.unlocking.map((p) => new RegExp(p, "i")),
    error: profile.statePatterns.error.map((p) => new RegExp(p, "i")),
  };
}

function heuristicDetect(output: string): ShellState {
  if (/[@:].*[#$]\s*$/m.test(output) || /PSH_AUTH=1/.test(output)) {
    return ShellState.READY;
  }
  if (/invalid\s+(key|password|code)/i.test(output) || /access\s+denied/i.test(output)) {
    return ShellState.ERROR;
  }
  if (/enter\s+(key|password|code|pin)/i.test(output) || /^key>\s*$/m.test(output) || /^password:\s*$/m.test(output)) {
    return ShellState.UNLOCKING;
  }
  if (/locked/i.test(output) || /system\s+is\s+locked/i.test(output) || /^locked>\s*$/m.test(output) ||
      /command not supported/i.test(output) || /not available in /i.test(output)) {
    return ShellState.LOCKED;
  }
  return ShellState.UNKNOWN;
}

export class ShellStateManager {
  readonly #profile: ShellProfile;
  readonly #compiled: CompiledPatterns;

  constructor(profile: ShellProfile) {
    this.#profile = profile;
    this.#compiled = compilePatterns(profile);
  }

  get profile(): ShellProfile {
    return this.#profile;
  }

  get unlockSequence(): UnlockStep[] {
    return this.#profile.unlockSequence ?? [];
  }

  get hasUnlockSequence(): boolean {
    return this.unlockSequence.length > 0;
  }

  get allowedCommands(): string[] {
    return this.#profile.statePatterns.locked.length > 0
      ? ["dmesg", "ps", "free", "top"]
      : [];
  }

  detectState(output: string): ShellState {
    if (this.#compiled.ready.some((p) => p.test(output))) {
      return ShellState.READY;
    }
    if (this.#compiled.error.some((p) => p.test(output))) {
      return ShellState.ERROR;
    }
    if (this.#compiled.unlocking.some((p) => p.test(output))) {
      return ShellState.UNLOCKING;
    }
    if (this.#compiled.locked.some((p) => p.test(output))) {
      return ShellState.LOCKED;
    }
    return ShellState.UNKNOWN;
  }

  buildPromptPattern(): RegExp {
    const parts: string[] = [];
    for (const p of this.#compiled.ready) {
      parts.push(p.source);
    }
    for (const p of this.#compiled.locked) {
      parts.push(p.source);
    }
    for (const p of this.#compiled.unlocking) {
      parts.push(p.source);
    }
    return new RegExp(parts.join("|"), "mi");
  }

  extractChallengeCode(output: string): string | null {
    if (!this.#profile.challengeCodePattern) {
      return null;
    }
    const match = output.match(new RegExp(this.#profile.challengeCodePattern, "i"));
    return match ? match[0] : null;
  }

  static fromEnv(): ShellStateManager {
    const profileName = process.env.BOARD_SHELL_PROFILE;

    if (profileName) {
      const builtin = BUILTIN_PROFILES[profileName];
      if (builtin) {
        return new ShellStateManager(builtin);
      }
    }

    const custom = buildProfileFromEnv();
    if (custom) {
      return new ShellStateManager(custom);
    }

    return ShellStateManager.heuristic();
  }

  static heuristic(): ShellStateManager {
    return new ShellStateManager({
      name: "heuristic",
      description: "Heuristic detection (no explicit profile)",
      statePatterns: {
        ready: [".*[@:].*[#$]\\s*$"],
        locked: ["locked>", "System is LOCKED", "Command not supported"],
        unlocking: ["key>", "Enter key", "password:"],
        error: ["invalid\\s+(key|password)", "access\\s+denied"],
      },
      unlockSequence: [],
    });
  }

  static matchBuiltin(output: string): ShellProfile | null {
    for (const [, profile] of Object.entries(BUILTIN_PROFILES)) {
      const locked = profile.statePatterns.locked.map((p) => new RegExp(p, "i"));
      if (locked.some((p) => p.test(output))) {
        return profile;
      }
    }
    return null;
  }
}
