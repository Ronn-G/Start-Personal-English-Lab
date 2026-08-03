import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BackupRestorePanel from "@/components/BackupRestorePanel";
import LessonDisplay from "@/components/LessonDisplay";
import { applyLessonProgressCommand, emptyLessonProgress } from "@/lib/lesson-progress";
import type { Lesson } from "@/types/lesson";

const storage = vi.hoisted(() => ({
  getLessonProgress: vi.fn(),
  updateLessonProgress: vi.fn(),
}));
const audio = vi.hoisted(() => ({
  cancelLesson: vi.fn(),
  preload: vi.fn(),
}));

vi.mock("@/lib/storage-client", () => ({ storageClient: storage }));
vi.mock("@/lib/audio-client", () => ({ audioClient: audio }));
vi.mock("@/components/AudioCacheControls", () => ({ default: () => null }));
vi.mock("@/components/SpeakingPractice", () => ({ default: () => null }));
vi.mock("@/components/ListeningPractice", () => ({ default: () => null }));
vi.mock("@/components/lesson/DeepPracticeSection", () => ({ default: () => null }));
vi.mock("@/components/lesson/GrammarSection", () => ({ default: () => null }));
vi.mock("@/components/lesson/IdiomsSection", () => ({ default: () => null }));
vi.mock("@/components/lesson/QuizSection", () => ({ default: () => null }));
vi.mock("@/components/lesson/SpeakButton", () => ({ default: () => null }));

const now = "2026-08-03T00:00:00.000Z";
const lesson: Lesson = {
  id: "lesson-capacity",
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  title: "Capacity fixture",
  summary: "A temporary component fixture.",
  vocabulary: Array.from({ length: 20 }, (_, index) => ({
    id: `vocabulary-${index}`,
    word: `word ${index}`,
    definition: "definition",
    vietnamese: "tu",
  })),
  idiomsAndSlang: [
    { id: "idiom-1", phrase: "keep going", meaning: "continue", vietnamese: "tiep tuc" },
  ],
  exampleSentences: Array.from({ length: 5 }, (_, index) => ({
    id: `example-${index}`,
    sentence: `Example ${index}`,
    keyPhrase: "example",
    vietnamese: "vi du",
  })),
  quiz: Array.from({ length: 5 }, (_, index) => ({
    id: `quiz-${index}`,
    question: `Question ${index}`,
    options: ["A", "B", "C", "D"],
    correctAnswer: 0,
    explanation: "Explanation",
  })),
  deepPractice: {
    shadowingPractice: {
      steps: ["Listen", "Repeat", "Shadow"],
      lines: Array.from({ length: 3 }, (_, index) => ({
        id: `shadow-${index}`,
        line: `Shadow ${index}`,
        focus: "shadow",
        vietnamese: "dong",
      })),
    },
    sentenceMining: Array.from({ length: 3 }, (_, index) => ({
      id: `mining-${index}`,
      sentence: `Mining ${index}`,
      pattern: "pattern",
      whyUseful: "Useful",
      remixPrompt: "Remix",
    })),
    reviewPlan: [1, 2, 4, 7].map((day) => ({ day: `Day ${day}`, task: "Review" })),
    ankiCards: Array.from({ length: 5 }, (_, index) => ({
      id: `card-${index}`,
      front: "Front",
      back: "Back",
    })),
  },
};

const responseJson = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("backup capacity diagnostics", () => {
  beforeEach(() => {
    storage.getLessonProgress.mockResolvedValue(null);
    storage.updateLessonProgress.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/backup/status")) {
          return responseJson({
            state: "too_large",
            estimatedBytes: 8_100_000,
            maximumBytes: 8_000_000,
            exportAvailable: false,
            reason:
              "Dữ liệu hiện tại vẫn được lưu bình thường, nhưng đã vượt kích thước tối đa của một tệp sao lưu.",
          });
        }
        return responseJson({ session: null, tasks: [], items: [] });
      }),
    );
  });

  it("keeps the warning inside Backup and disables only export", async () => {
    render(<BackupRestorePanel lessonCount={1} onImported={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Bản sao lưu hiện quá dung lượng");
    expect(screen.getByRole("status")).toHaveTextContent("8.100.000 byte");
    expect(screen.getByRole("status")).toHaveTextContent(
      "vẫn có thể học và lưu tiến độ bình thường",
    );
    expect(screen.getByRole("button", { name: "Tải bản sao lưu" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an exact ready estimate and keeps export available", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/backup/status")) {
        return responseJson({
          state: "ready",
          estimatedBytes: 7_999_999,
          maximumBytes: 8_000_000,
          exportAvailable: true,
        });
      }
      return responseJson({ session: null, tasks: [], items: [] });
    });

    render(<BackupRestorePanel lessonCount={1} onImported={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Sẵn sàng sao lưu");
    expect(screen.getByRole("status")).toHaveTextContent("Dung lượng ước tính: 7.999.999 byte");
    expect(screen.getByRole("status")).toHaveTextContent("Giới hạn một tệp: 8.000.000 byte");
    expect(screen.getByRole("button", { name: "Tải bản sao lưu" })).toBeEnabled();
  });

  it("persists Vocabulary optimistically without a global backup error and survives reload", async () => {
    const initial = emptyLessonProgress(lesson.id, lesson.createdAt);
    const learned = applyLessonProgressCommand(initial, lesson, {
      type: "mark_learning_item_reviewed",
      itemId: lesson.vocabulary[0].id,
    });
    const first = render(<LessonDisplay lesson={lesson} />);
    await waitFor(() => expect(storage.getLessonProgress).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /word 0/ }));
    await waitFor(() => expect(storage.updateLessonProgress).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Đã học")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    first.unmount();
    storage.getLessonProgress.mockResolvedValue({ progress: learned });
    render(<LessonDisplay lesson={lesson} />);
    expect(await screen.findByText("Đã học")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a real mutation failure visible and retryable", async () => {
    storage.updateLessonProgress
      .mockRejectedValueOnce(new Error("Database is temporarily unavailable"))
      .mockResolvedValueOnce({});

    render(<LessonDisplay lesson={lesson} />);
    await waitFor(() => expect(storage.getLessonProgress).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /word 0/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa lưu tiến độ: Database is temporarily unavailable",
    );

    await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(storage.updateLessonProgress).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
