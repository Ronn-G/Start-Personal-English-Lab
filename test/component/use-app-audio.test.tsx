import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AudioClientError } from "@/lib/audio-client";
import { useAppAudio } from "@/hooks/useAppAudio";

const client = vi.hoisted(() => ({
  cancelLesson: vi.fn(),
  preload: vi.fn(async () => undefined),
  prepare: vi.fn(),
}));

vi.mock("@/lib/audio-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio-client")>();
  return { ...actual, audioClient: client };
});

interface FakeAudioInstance {
  currentTime: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  url: string;
}

let audioInstances: FakeAudioInstance[];

beforeEach(() => {
  audioInstances = [];
  vi.stubGlobal(
    "Audio",
    vi.fn(function MockAudio(url: string) {
      const instance: FakeAudioInstance = {
        currentTime: 0,
        onended: null,
        onerror: null,
        pause: vi.fn(),
        play: vi.fn(async () => undefined),
        url,
      };
      audioInstances.push(instance);
      return instance;
    }),
  );
});

describe("useAppAudio", () => {
  it("stays preparing without fallback until Kokoro becomes ready", async () => {
    let resolvePrepare!: (url: string) => void;
    client.prepare.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const { result } = renderHook(() => useAppAudio("lesson-1"));
    let playing!: Promise<void>;
    act(() => {
      playing = result.current.play("item-1", "A sentence.");
    });
    expect(result.current.audioStatus("item-1").status).toBe("preparing");
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();

    resolvePrepare("/api/audio/file.wav");
    await act(async () => playing);
    expect(result.current.audioStatus("item-1").status).toBe("ready");
    expect(result.current.state.source).toBe("kokoro");
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  it("uses browser voice only after a real prepare failure, then Retry Kokoro reaches ready", async () => {
    client.prepare
      .mockRejectedValueOnce(
        new AudioClientError("KOKORO_UNAVAILABLE", "Kokoro is unavailable.", true),
      )
      .mockResolvedValueOnce("/api/audio/recovered.wav");
    const { result } = renderHook(() => useAppAudio("lesson-1"));
    await act(async () => {
      await result.current.play("item-1", "A sentence.");
    });
    expect(result.current.audioStatus("item-1").status).toBe("browser");
    expect(result.current.state.source).toBe("browser");
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retryKokoro("item-1", "A sentence.", 0.86);
    });
    expect(result.current.audioStatus("item-1").status).toBe("ready");
    expect(client.prepare).toHaveBeenLastCalledWith(
      "A sentence.",
      "lesson-1",
      0.86,
      expect.any(Function),
      { retryMode: "manual", sourceType: "listening" },
    );
  });

  it("does not turn media playback rejection into browser fallback", async () => {
    client.prepare.mockResolvedValueOnce("/api/audio/file.wav");
    vi.stubGlobal(
      "Audio",
      vi.fn(function MockRejectedAudio(url: string) {
        const instance: FakeAudioInstance = {
          currentTime: 0,
          onended: null,
          onerror: null,
          pause: vi.fn(),
          play: vi.fn(async () => {
            throw new Error("media blocked");
          }),
          url,
        };
        audioInstances.push(instance);
        return instance;
      }),
    );
    const { result } = renderHook(() => useAppAudio("lesson-1"));
    await act(async () => {
      await result.current.play("item-1", "A sentence.");
    });
    expect(result.current.audioStatus("item-1").status).toBe("failed");
    expect(result.current.state.error).toMatch(/could not start/i);
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("prepares exactly once for Loop 3 and Loop 5 and cleans up on Stop and unmount", async () => {
    client.prepare.mockResolvedValue("/api/audio/file.wav");
    const recorded = vi.fn();
    const { result, unmount } = renderHook(() => useAppAudio("lesson-1", recorded));
    await act(async () => {
      await result.current.play("item-1", "A sentence.", 3);
    });
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(result.current.state.target).toBe(3);
    act(() => result.current.stop(false));
    expect(audioInstances[0].pause).toHaveBeenCalled();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();

    await act(async () => {
      await result.current.play("item-2", "Another sentence.", 5);
    });
    expect(client.prepare).toHaveBeenCalledTimes(2);
    expect(result.current.state.target).toBe(5);
    unmount();
    expect(audioInstances[1].pause).toHaveBeenCalled();
    expect(client.cancelLesson).toHaveBeenCalledWith("lesson-1");
    await waitFor(() => expect(window.speechSynthesis.cancel).toHaveBeenCalled());
  });
});
