import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type ReviewItem, type ScoreConfig } from "../lib/api";
import { useSession } from "../lib/auth";

export const Route = createFileRoute("/review")({ component: ReviewPage });

function pretty(v: string): string {
  if (!v) return "—";
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

function ReviewCard({
  queue,
  item,
  config,
  myId,
  onDone,
}: {
  queue: string;
  item: ReviewItem;
  config?: ScoreConfig;
  myId?: string;
  onDone: () => void;
}) {
  const categorical = config?.dataType === "CATEGORICAL" && config.categories.length > 0;
  const [value, setValue] = useState(1);
  const [stringValue, setStringValue] = useState(config?.categories[0] ?? "");
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: () =>
      api.submitReviewScore(queue, item.id, categorical ? { stringValue, comment } : { value, comment }),
    onSuccess: onDone,
  });
  const assign = useMutation({
    mutationFn: (assigneeId?: string) => api.assignReviewItem(queue, item.id, assigneeId),
    onSuccess: onDone,
  });
  const mine = item.assigneeId && item.assigneeId === myId;
  return (
    <li>
      <div className="obs-meta">
        <Link to="/traces/$id" params={{ id: item.traceId }}>
          {item.trace.name || item.traceId.slice(0, 8)} →
        </Link>
        {item.assigneeId ? (
          <>
            {" · "}
            <span className="badge gen">{mine ? "assigned to you" : "assigned"}</span>{" "}
            <button className="link-btn" onClick={() => assign.mutate("")}>
              unassign
            </button>
          </>
        ) : (
          <>
            {" · "}
            <button className="link-btn" onClick={() => assign.mutate(undefined)}>
              assign to me
            </button>
          </>
        )}
      </div>
      {item.trace.input && <pre>{pretty(item.trace.input)}</pre>}
      {item.trace.output && <pre>{pretty(item.trace.output)}</pre>}
      <div className="filters">
        {categorical ? (
          <select value={stringValue} onChange={(e) => setStringValue(e.target.value)}>
            {config!.categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            step="0.1"
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            title="score value"
            style={{ width: 90 }}
          />
        )}
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
  const { data: session } = useSession();
  const myId = session?.user.id;
  const { data: queues } = useQuery({ queryKey: ["review-queues"], queryFn: () => api.listReviewQueues() });
  const [selected, setSelected] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

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
    queryKey: ["review-items", selected, mineOnly],
    queryFn: () => api.listReviewItems(selected!, mineOnly ? { assignee: "me" } : {}),
    enabled: !!selected,
    refetchInterval: 5_000,
  });
  const { data: scoreConfigs } = useQuery({ queryKey: ["score-configs"], queryFn: () => api.listScoreConfigs() });
  const queueConfig = scoreConfigs?.find((s) => s.name === items?.queue.scoreName);

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
          <div className="filters">
            <label className="inline-check">
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> assigned to
              me only
            </label>
          </div>
          {items && items.items.length === 0 ? (
            <div className="empty">Nothing to review.</div>
          ) : (
            <ul className="tree">
              {items?.items.map((item) => (
                <ReviewCard
                  key={item.id}
                  queue={selected}
                  item={item}
                  config={queueConfig}
                  myId={myId}
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
