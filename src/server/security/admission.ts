import { ApiRequestError } from "./local-request";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LocalAdmissionGate {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    private readonly name: string,
    private readonly maxInFlight: number,
    private readonly maxWaiting: number,
    private readonly maxWaitMs: number,
  ) {
    if (maxInFlight < 1 || maxWaiting < 0 || maxWaitMs < 1) {
      throw new Error("Invalid admission limits.");
    }
  }

  info() {
    return {
      name: this.name,
      maxInFlight: this.maxInFlight,
      maxWaiting: this.maxWaiting,
      active: this.active,
      waiting: this.waiting.length,
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.maxInFlight) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(
        new ApiRequestError(
          "LOCAL_CAPACITY_EXCEEDED",
          429,
          `${this.name} is busy. Please try again shortly.`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(
            new ApiRequestError(
              "LOCAL_CAPACITY_TIMEOUT",
              503,
              `${this.name} stayed busy for too long. Please try again.`,
            ),
          );
        }, this.maxWaitMs),
      };
      this.waiting.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

const securityGlobal = globalThis as typeof globalThis & {
  __personalEnglishLabGeminiAdmission?: LocalAdmissionGate;
};

export const geminiAdmission = (securityGlobal.__personalEnglishLabGeminiAdmission ??=
  new LocalAdmissionGate("AI operation", 2, 4, 15_000));
