import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ListeningPractice from "@/components/ListeningPractice";

const audio = vi.hoisted(() => ({
  audioStatus: vi.fn(() => ({ status: "idle" as const })),
  play: vi.fn(async () => undefined),
  preload: vi.fn(),
  retryKokoro: vi.fn(async () => undefined),
  state: {
    itemId: null,
    loading: false,
    playing: false,
    paused: false,
    completed: 0,
    target: 0,
  },
  stop: vi.fn(),
  togglePause: vi.fn(),
}));

vi.mock("@/hooks/useAppAudio", () => ({
  useAppAudio: () => audio,
}));

const oldItems = ["shadow", "example", "mining", "vocabulary"].map((sourceType, index) => ({
  id: `selected-${index + 1}`,
  lessonId: "lesson-1",
  sourceType,
  sourceItemId: `source-${index + 1}`,
  text: `Snapshot sentence ${index + 1}.`,
  targetPhrase: `phrase ${index + 1}`,
  sourceAvailable: true,
  progress: {
    listenCount: 0,
    loopCount: 0,
    transcriptRevealed: false,
    savedForRelisten: false,
    lastListenedAt: null,
  },
}));
const newItems = oldItems.map((item, index) => ({
  ...item,
  id: `new-selected-${index + 1}`,
  sourceItemId: `new-source-${index + 1}`,
  text: `Updated lesson sentence ${index + 1}.`,
}));
const oldTrack = oldItems.map((item) => item.text).join(" ");
const newTrack = newItems.map((item) => item.text).join(" ");

function responseJson(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function makeServer(options?: {
  completed?: boolean;
  conflictOnSave?: boolean;
  deferredSave?: { promise: Promise<Response> };
  initialStep?: string;
  stale?: boolean;
}) {
  let items = oldItems.map((item, index) => ({
    ...item,
    sourceAvailable: options?.stale && index === 0 ? false : true,
  }));
  let track = oldTrack;
  let step = options?.completed ? "complete" : (options?.initialStep ?? "first_listen");
  let status = options?.completed ? "completed" : "active";
  let revealed: string[] = options?.completed ? items.map((item) => item.id) : [];
  let saved = false;
  const requests: Array<Record<string, unknown>> = [];

  const data = () => ({
    lessonId: "lesson-1",
    lessonTitle: "Listening fixture",
    summary: "A coherent listening fixture.",
    track,
    empty: false,
    items: items.map((item, index) => ({
      ...item,
      progress: {
        ...item.progress,
        savedForRelisten: index === 1 ? saved : false,
      },
    })),
    session: {
      id: status === "completed" ? "completed-session" : "active-session",
      lessonId: "lesson-1",
      status,
      currentStep: step,
      firstListenComprehension: step === "first_listen" ? null : "main_idea",
      firstListenNote: "",
      secondListenComprehension:
        step === "sentence_review" || step === "final_relisten" || step === "complete"
          ? "most_of_it"
          : null,
      finalNote: "",
      revealedItemIds: revealed,
      selectedItemIds: items.map((item) => item.id),
      trackHash: track === oldTrack ? "old-track-hash" : "new-track-hash",
      lessonContentHash: track === oldTrack ? "old-lesson-hash" : "new-lesson-hash",
      selectionVersion: 1,
      startedAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      completedAt: status === "completed" ? "2026-08-02T00:10:00.000Z" : null,
    },
  });

  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(request);
    if (request.action === "status") return responseJson(data());
    if (request.action === "save_first_listen") {
      if (options?.deferredSave) return options.deferredSave.promise;
      if (options?.conflictOnSave) {
        step = "check_meaning";
        return responseJson({ error: "Session changed in another tab." }, 409);
      }
      step = "check_meaning";
    } else if (request.action === "reveal_all") {
      revealed = [...(request.itemIds as string[])];
    } else if (request.action === "advance_step") {
      step = String(request.nextStep);
    } else if (request.action === "save_second_listen") {
      step = "sentence_review";
    } else if (request.action === "complete") {
      step = "complete";
      status = "completed";
    } else if (request.action === "practice_again") {
      items = newItems;
      track = newTrack;
      step = "first_listen";
      status = "active";
      revealed = [];
    } else if (request.action === "set_saved_for_relisten") {
      saved = Boolean(request.saved);
    }
    return responseJson(data());
  });
  return { data, fetchMock, requests };
}

function selectedDomIds(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-listening-item-id]")].map(
    (element) => element.dataset.listeningItemId,
  );
}

describe("ListeningPractice coherent flow", () => {
  beforeEach(() => {
    audio.play.mockClear();
    audio.preload.mockClear();
    audio.stop.mockClear();
  });

  it("keeps the same selected IDs and central track through every listening step and resume", async () => {
    const server = makeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    const user = userEvent.setup();
    const view = render(
      <ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />,
    );

    expect(await screen.findByRole("heading", { name: "First Listen" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.play).toHaveBeenLastCalledWith("track", oldTrack, 1, 0.86);
    await user.click(screen.getByRole("button", { name: /Main idea/ }));
    await user.click(screen.getByRole("button", { name: "Check the meaning" }));

    expect(await screen.findByRole("heading", { name: "Check Meaning" })).toBeVisible();
    expect(selectedDomIds(view.container)).toEqual(oldItems.map((item) => item.id));
    expect(screen.getAllByText("This sentence stays hidden until you reveal it.")).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    await waitFor(() => {
      expect(server.requests.find((request) => request.action === "reveal_all")?.itemIds).toEqual(
        oldItems.map((item) => item.id),
      );
    });

    await user.click(screen.getByRole("button", { name: "Listen again" }));
    expect(await screen.findByRole("heading", { name: "Second Listen" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.play).toHaveBeenLastCalledWith("track", oldTrack, 1, 0.86);
    await user.click(screen.getByRole("button", { name: /Most of it/ }));
    await user.click(screen.getByRole("button", { name: "Review the sentences" }));

    expect(await screen.findByRole("heading", { name: "Sentence Review" })).toBeVisible();
    expect(selectedDomIds(view.container)).toEqual(oldItems.map((item) => item.id));
    for (const item of oldItems) expect(screen.getByText(item.text)).toBeVisible();
    expect(audio.preload).toHaveBeenCalledWith(oldItems, 0.86);
    await user.click(screen.getByRole("button", { name: "Go to final re-listen" }));

    expect(await screen.findByRole("heading", { name: "Final Re-listen" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.play).toHaveBeenLastCalledWith("track", oldTrack, 1, 0.86);

    view.unmount();
    render(<ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Final Re-listen" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.play).toHaveBeenLastCalledWith("track", oldTrack, 1, 0.86);
  });

  it("keeps an active snapshot after source mutation and Practice Again adopts the new snapshot", async () => {
    const active = makeServer({ stale: true });
    vi.stubGlobal("fetch", active.fetchMock);
    const first = render(
      <ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />,
    );
    expect(await screen.findByRole("heading", { name: "First Listen" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Main idea/ }));
    await userEvent.click(screen.getByRole("button", { name: "Check the meaning" }));
    expect(selectedDomIds(first.container)).toEqual(oldItems.map((item) => item.id));
    first.unmount();

    const completed = makeServer({ completed: true });
    vi.stubGlobal("fetch", completed.fetchMock);
    render(<ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />);
    expect(
      await screen.findByRole("heading", {
        name: "Listening session complete",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Practice Again" }));
    expect(await screen.findByRole("heading", { name: "First Listen" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.play).toHaveBeenLastCalledWith("track", newTrack, 1, 0.86);
  });

  it("blocks duplicate mutations, exposes busy state, and preserves keyboard focus", async () => {
    let resolveSave!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const server = makeServer({ deferredSave: { promise: pending } });
    vi.stubGlobal("fetch", server.fetchMock);
    render(<ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />);
    const option = await screen.findByRole("button", { name: /Main idea/ });
    option.focus();
    await userEvent.keyboard("{Enter}");
    expect(option).toHaveAttribute("aria-pressed", "true");
    expect(option).toHaveFocus();
    const action = screen.getByRole("button", { name: "Check the meaning" });
    fireEvent.click(action);
    fireEvent.click(action);
    await waitFor(() => expect(action).toBeDisabled());
    expect(
      server.requests.filter((request) => request.action === "save_first_listen"),
    ).toHaveLength(1);
    resolveSave(
      await responseJson({
        ...server.data(),
        session: { ...server.data().session, currentStep: "check_meaning" },
      }),
    );
    expect(await screen.findByRole("heading", { name: "Check Meaning" })).toBeVisible();
  });

  it("reloads authoritative state after a conflict and announces the error", async () => {
    const server = makeServer({ conflictOnSave: true });
    vi.stubGlobal("fetch", server.fetchMock);
    const user = userEvent.setup();
    render(<ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Main idea/ }));
    await user.click(screen.getByRole("button", { name: "Check the meaning" }));
    expect(await screen.findByRole("heading", { name: "Check Meaning" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Session changed in another tab.");
    expect(server.requests.filter((request) => request.action === "status")).toHaveLength(2);
  });

  it("saves and removes bookmarks while stale sources remain safe", async () => {
    const server = makeServer({ stale: true, initialStep: "sentence_review" });
    vi.stubGlobal("fetch", server.fetchMock);
    const user = userEvent.setup();
    render(<ListeningPractice lessonId="lesson-1" onExit={vi.fn()} onOpenSpeaking={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Sentence Review" })).toBeVisible();
    expect(screen.getByText(/source sentence no longer exists/i)).toHaveAttribute("role", "status");
    const staleCard = screen.getByText(/source sentence no longer exists/i).closest("article")!;
    expect(staleCard.querySelector("button[aria-pressed]")).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: "Save for re-listen" })[1]);
    expect(await screen.findByRole("button", { name: "Remove from re-listen" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove from re-listen" }));
    expect(await screen.findAllByRole("button", { name: "Save for re-listen" })).toHaveLength(4);
  });
});
