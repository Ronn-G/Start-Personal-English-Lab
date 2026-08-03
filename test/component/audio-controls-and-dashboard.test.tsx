import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ListeningAudioControls, PracticeTrack } from "@/components/listening/AudioControls";
import RelistenDashboard from "@/components/listening/RelistenDashboard";

const dashboardPlay = vi.hoisted(() => vi.fn());
vi.mock("@/components/lesson/SpeakButton", () => ({
  default: (props: { itemId: string; label: string; text: string }) => (
    <button type="button" onClick={() => dashboardPlay(props)}>
      {props.label}
    </button>
  ),
}));

function playback(overrides?: {
  itemId?: string | null;
  playing?: boolean;
  paused?: boolean;
  status?: "idle" | "preparing" | "retrying" | "ready" | "browser" | "failed";
}) {
  return {
    audioStatus: vi.fn(() => ({ status: overrides?.status ?? "idle" })),
    play: vi.fn(async () => undefined),
    preload: vi.fn(),
    retryKokoro: vi.fn(async () => undefined),
    state: {
      itemId: overrides?.itemId ?? null,
      loading: false,
      playing: overrides?.playing ?? false,
      paused: overrides?.paused ?? false,
      completed: 0,
      target: 1,
    },
    stop: vi.fn(),
    togglePause: vi.fn(),
  };
}

describe("shared listening controls", () => {
  it("announces browser fallback and exposes Retry Kokoro for the central track", async () => {
    const state = playback({
      itemId: "track",
      playing: true,
      status: "browser",
    });
    render(
      <PracticeTrack
        track="The selected track."
        rate={0.86}
        setRate={vi.fn()}
        playback={state as never}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Using browser voice");
    await userEvent.click(screen.getByRole("button", { name: "Retry Kokoro" }));
    expect(state.retryKokoro).toHaveBeenCalledWith(
      "track",
      "The selected track.",
      0.86,
      "listening",
    );
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(state.togglePause).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.stop).toHaveBeenCalledWith(false);
  });

  it("sends one shared play command for each Loop 3 and Loop 5 activation", async () => {
    const state = playback({ itemId: "item-1", playing: true, status: "ready" });
    render(
      <ListeningAudioControls
        item={{ id: "item-1", text: "A selected sentence." }}
        rate={0.86}
        playback={state as never}
        loops
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Kokoro audio ready");
    await userEvent.click(screen.getByRole("button", { name: "Loop 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Loop 5" }));
    expect(state.play.mock.calls).toEqual([
      ["item-1", "A selected sentence.", 3, 0.86],
      ["item-1", "A selected sentence.", 5, 0.86],
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(state.togglePause).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.stop).toHaveBeenCalledWith(true);
  });
});

describe("Re-listen dashboard", () => {
  it("plays, opens, and removes a saved sentence", async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const item = {
      lessonId: "lesson-1",
      title: "Listening fixture",
      itemId: "item-1",
      sourceType: "example",
      sourceItemId: "source-1",
      text: "A saved sentence.",
      targetPhrase: "saved sentence",
    };
    render(
      <RelistenDashboard items={[item]} removingId={null} onOpen={onOpen} onRemove={onRemove} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(dashboardPlay).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1", text: "A saved sentence." }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open lesson" }));
    expect(onOpen).toHaveBeenCalledWith("lesson-1");
    await userEvent.click(screen.getByRole("button", { name: "Remove from re-listen" }));
    expect(onRemove).toHaveBeenCalledWith(item);
  });
});
