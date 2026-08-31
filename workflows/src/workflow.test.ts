import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "./events.ts";
import { Workflow } from "./workflow.ts";

test("steps run in order and can read earlier results", async () => {
  const workflow = new Workflow<{ start: number }>({
    name: "arithmetic",
    steps: [
      { name: "double", run: async ({ input }) => input.start * 2 },
      { name: "increment", run: async ({ results }) => (results.double as number) + 1 },
    ],
  });

  const run = await workflow.execute({ start: 20 });

  assert.equal(run.status, "succeeded");
  assert.equal(run.results.increment, 41);
  assert.deepEqual(
    run.steps.map((step) => step.name),
    ["double", "increment"],
  );
});

test("a failing step retries up to maxAttempts and then succeeds", async () => {
  let attempts = 0;
  const workflow = new Workflow({
    name: "flaky",
    steps: [
      {
        name: "unstable",
        retry: { maxAttempts: 3, backoffMs: 1 },
        run: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("transient");
          return "recovered";
        },
      },
    ],
  });

  const run = await workflow.execute({});

  assert.equal(run.status, "succeeded");
  assert.equal(run.steps[0]?.attempts, 3);
});

test("a failure stops later steps but alwaysRun steps still execute", async () => {
  let cleanedUp = false;
  const workflow = new Workflow({
    name: "failing",
    steps: [
      {
        name: "boom",
        run: async () => {
          throw new Error("nope");
        },
      },
      { name: "never", run: async () => "unreachable" },
      {
        name: "cleanup",
        alwaysRun: true,
        run: async () => {
          cleanedUp = true;
          return "done";
        },
      },
    ],
  });

  const run = await workflow.execute({});

  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /Step "boom" failed: nope/);
  assert.equal(run.steps[1]?.status, "skipped");
  assert.equal(cleanedUp, true);
});

test("a step whose condition is false is skipped", async () => {
  const workflow = new Workflow<{ enabled: boolean }>({
    name: "conditional",
    steps: [{ name: "optional", when: ({ input }) => input.enabled, run: async () => "ran" }],
  });

  const run = await workflow.execute({ enabled: false });

  assert.equal(run.steps[0]?.status, "skipped");
  assert.equal(run.status, "succeeded");
});

test("a step that exceeds its timeout fails", async () => {
  const workflow = new Workflow({
    name: "slow",
    steps: [
      {
        name: "hang",
        timeoutMs: 20,
        run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)),
      },
    ],
  });

  const run = await workflow.execute({});

  assert.equal(run.status, "failed");
  assert.match(run.steps[0]?.error ?? "", /timed out/);
});

test("duplicate step names are rejected at construction", () => {
  assert.throws(
    () =>
      new Workflow({
        name: "dupes",
        steps: [
          { name: "a", run: async () => 1 },
          { name: "a", run: async () => 2 },
        ],
      }),
    /Duplicate step name/,
  );
});

test("one failing event handler does not block the others", async () => {
  const errors: unknown[] = [];
  const bus = new EventBus((error) => errors.push(error));
  const seen: string[] = [];

  bus.on("ping", () => {
    throw new Error("handler blew up");
  });
  bus.on("ping", () => {
    seen.push("second");
  });

  await bus.emit("ping", {});

  assert.deepEqual(seen, ["second"]);
  assert.equal(errors.length, 1);
});
