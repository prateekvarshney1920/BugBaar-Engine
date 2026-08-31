import { InMemoryJobQueue } from "./queue.ts";
import { runJobQueueContract } from "./queue-contract.ts";

// The same contract the Redis-backed queue must satisfy. Running it here means
// a divergence between the two fails the suite with no infrastructure needed.
runJobQueueContract("InMemoryJobQueue", {
  createQueue: async (runner) => new InMemoryJobQueue({ runner, onError: () => undefined }),
  retryTimeoutMs: 4_000,
});
