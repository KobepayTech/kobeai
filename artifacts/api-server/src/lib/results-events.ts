import { EventEmitter } from "node:events";

// In-process bus for live results: every recorded or removed exam result is
// published here and streamed to the dashboard scoreboard (GET
// /v1/results/stream). A single K9 school server runs one api-server process,
// so an EventEmitter is enough.

export type ResultEvent = {
  type: "result_recorded" | "result_removed";
  exam_id: number;
  class_id: number;
  term_id: number;
  subject: string;
  exam_title: string;
  student_id: number;
  student_code: string | null;
  student_name: string | null;
  marks: number | null;
  percent: number | null;
  total_marks: number;
  at: string;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishResult(event: ResultEvent): void {
  bus.emit("result", event);
}

export function onResult(listener: (event: ResultEvent) => void): () => void {
  bus.on("result", listener);
  return () => bus.off("result", listener);
}
