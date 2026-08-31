import { InMemoryVectorStore } from "./store.ts";
import { runVectorStoreContract } from "./store-contract.ts";

// The same contract the Qdrant backend must satisfy. Running it here means a
// divergence between the two implementations fails the suite with no
// infrastructure required.
runVectorStoreContract("InMemoryVectorStore", {
  createStore: async () => new InMemoryVectorStore(),
});
