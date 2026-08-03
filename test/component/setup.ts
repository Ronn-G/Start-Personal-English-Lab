import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class TestSpeechSynthesisUtterance {
  lang = "";
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly text: string) {}
}

Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
  configurable: true,
  value: TestSpeechSynthesisUtterance,
});

Object.defineProperty(window, "speechSynthesis", {
  configurable: true,
  value: {
    cancel: vi.fn(),
    getVoices: vi.fn(() => []),
    pause: vi.fn(),
    resume: vi.fn(),
    speak: vi.fn(),
  },
});

Object.defineProperty(window, "confirm", {
  configurable: true,
  value: vi.fn(() => true),
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
