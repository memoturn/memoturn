import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type ReviewItem } from "../lib/api";

export const Route = createFileRoute("/review")({ component: ReviewPage });

function pretty(v: string): string {
  if (!v) return "—";
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

function ReviewCard({ queue, item, onDone }: { queue: string; item: ReviewItem; onDone: () => void }) {
  const [value, setValue] = useState(1);
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: () => api.submitReviewScore(queue, item.id, { value, comment }),
    onSuccess: onDone,
  });
  return (
    <li>
      <div className="obs-meta">
        <Link to="/traces/$id" params={{ id: item.traceId }}>
          {item.trace.name || item.traceId.slice(0, 8)} →
        </Link>
      </div>
      {item.trace.input && <pre>{pretty(item.trace.input)}</pre>}
      {item.trace.output && <pre>{pretty(item.trace.output)}</pre>}
      <div className="filters">
        <input
          type="number"
          step="0.1"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          title="score value"
          style={{ width: 90 }}
        />
        <input
          placeholder="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ width: 260 }}
        />
        <button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : "Submit score"}
        </button>
      </div>
    </li>
  );
}

function ReviewPage() {
  const qc = useQueryClient();
  const { data: queues } = useQuery({ queryKey: ["review-queues"], queryFn: () => api.listReviewQueues() });
  const [selected, setSelected] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [scoreName, setScoreName] = useState("human-rating");
  const create = useMutation({
    mutationFn: () => api.createReviewQueue({ name, scoreName }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["review-queues"] });
    },
  });

  const { data: items } = useQuery({
    queryKey: ["review-items", selected],
    queryFn: () => api.listReviewItems(selected!),
    enabled: !!selected,
    refetchInterval: 5_000,
  });

  return (
    <div>
      <h1>Review queues</h1>
      <p className="obs-meta">
        Human-in-the-loop annotation. Submitting a review writes an ANNOTATION score on the trace.
      </p>

      <h2>New queue</h2>
      <div className="filters">
        <input placeholder="queue name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="score name" value={scoreName} onChange={(e) => setScoreName(e.target.value)} />
        <button disabled={!name || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Saving…" : "Create"}
        </button>
      </div>

      <h2>Queues</h2>
      {!queues || queues.length === 0 ? (
        <div className="empty">No review queues yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Score</th>
              <th>Pending</th>
              <th>Done</th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.name}>
                <td>
                  <button className="link-btn" onClick={() => setSelected(q.name)}>
                    {q.name}
                  </button>
                </td>
                <td>{q.scoreName}</td>
                <td>{q.pending}</td>
                <td>{q.done}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <>
          <h2>
            Reviewing: {selected} ({items?.items.length ?? 0} pending)
          </h2>
          {items && items.items.length === 0 ? (
            <div className="empty">Nothing to review.</div>
          ) : (
            <ul className="tree">
              {items?.items.map((item) => (
                <ReviewCard
                  key={item.id}
                  queue={selected}
                  item={item}
                  onDone={() => {
                    qc.invalidateQueries({ queryKey: ["review-items", selected] });
                    qc.invalidateQueries({ queryKey: ["review-queues"] });
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
