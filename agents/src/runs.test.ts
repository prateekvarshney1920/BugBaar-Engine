import { runAgentRunStoreContract } from "./run-store-contract.ts";
import { InMemoryAgentRunStore } from "./runs.ts";

// The same contract the MongoDB-backed store must satisfy. Running it here
// means a divergence between the two fails the suite with no infrastructure.
runAgentRunStoreContract("InMemoryAgentRunStore", {
  createStore: async () => new InMemoryAgentRunStore(),
});
